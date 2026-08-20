/**
 * The conversation engine, event-driven.
 *
 * There is no workflow graph any more. What happens to a lead is decided by its
 * stage and by events — an opener is drafted, a reply arrives, the clock runs
 * out on a chase — not by walking nodes and edges. The playbook is prose the
 * model follows (lib/qualify.ts); this file is the half that touches the
 * database and turns an AI turn into stage transitions and drafts.
 *
 * Channel-agnostic on purpose: the manual relay drives it today, and the email
 * poller (phase 2) will call exactly the same functions.
 */

import { TERMINAL_STAGES, type LeadRow, type Stage } from "./db";
import type { Channel } from "./csv";
import {
  addThread,
  appendMessage,
  assignBrain,
  claimStage,
  clearDue,
  getLead,
  leadCollected,
  listMessages,
  markFirstOutreach,
  markMessageSent,
  pendingDraft,
  saveConversationState,
  setDecision,
  setLeadError,
  setNextDue,
  type MessageRow,
} from "./leads";
import {
  defaultCharacter,
  defaultPlaybook,
  ensureSeeded,
  getCharacter,
  getPlaybook,
  toCharacterSpec,
  type CharacterRow,
} from "./brain";
import { ensureCriteriaSeeded, listCriteria } from "./criteriaStore";
import { targetedCriteria, type Criterion, type CriteriaRegistry } from "./criteria";
import type { PlaybookSpec } from "./playbookSpec";
import { llmFor } from "./llm";
import { providerConfigFor } from "./connections";
import { loadPromptLayer } from "./promptStore";
import { buildDecision, handoffReason, runTurn, type TurnOutcome } from "./qualify";

export type StepResult =
  | {
      kind: "drafted";
      message: MessageRow;
      /** The AI is done after this one — send it, then review the decision. */
      final: boolean;
      ungrounded?: string[];
    }
  | { kind: "decided"; verdict: "qualified" | "rejected"; summary: string; label: string }
  | { kind: "blocked"; errors: string[] }
  | { kind: "skipped"; reason: string };

const NON_TERMINAL: Stage[] = ["fresh", "outreached", "replied", "decision"];
const DAY_MINUTES = 60 * 24;

// ─── Channel resolution ──────────────────────────────────────────────────────

/** The channel a lead is contacted on. Falls back to email. */
export function relayChannel(lead: LeadRow): Channel {
  return (lead.preferred_channel as Channel) ?? "email";
}

/** Synthetic thread id for a conversation the tool can't address directly. */
export function manualThreadId(leadId: number): string {
  return `manual:${leadId}`;
}

// ─── Context ─────────────────────────────────────────────────────────────────

interface Context {
  playbook: PlaybookSpec;
  character: CharacterRow;
  criteria: CriteriaRegistry;
  targets: Criterion[];
}

function loadContext(lead: LeadRow): Context | null {
  ensureSeeded();
  ensureCriteriaSeeded();
  const playbook = (lead.playbook_id ? getPlaybook(lead.playbook_id) : null) ?? defaultPlaybook();
  const character = (lead.character_id ? getCharacter(lead.character_id) : null) ?? defaultCharacter();
  if (!playbook || !character) return null;
  const criteria = listCriteria();
  return {
    playbook: playbook.spec,
    character,
    criteria,
    targets: targetedCriteria(criteria, playbook.spec.criteriaKeys),
  };
}

/** AI messages actually sent so far — what the message cap and follow-ups count. */
function aiMessagesSent(leadId: number): number {
  return listMessages(leadId).filter(
    (m) => m.direction === "outbound" && m.sent_by === "ai" && m.sent_at,
  ).length;
}

// ─── The engine ──────────────────────────────────────────────────────────────

/**
 * Do whatever this lead's state calls for.
 *
 * Refuses deliberately rather than silently: the lead is finished, a human has
 * taken over, or a previous draft is still unsent. Otherwise it dispatches on
 * the board stage — the source of truth now that there's no graph position.
 */
export async function runStep(leadId: number): Promise<StepResult> {
  const lead = getLead(leadId);
  if (!lead) return { kind: "skipped", reason: "That lead no longer exists." };
  if (TERMINAL_STAGES.includes(lead.stage)) {
    return { kind: "skipped", reason: "This lead is finished." };
  }
  if (lead.ai_enabled === 0) {
    return { kind: "skipped", reason: "A human has taken over this conversation." };
  }
  if (pendingDraft(leadId)) {
    return {
      kind: "skipped",
      reason: "There's already a message waiting to be sent. Send or discard it first.",
    };
  }

  const ctx = loadContext(lead);
  if (!ctx) {
    return { kind: "skipped", reason: "No playbook or character set up yet — see the Brain page." };
  }
  if (lead.playbook_id === null || lead.character_id === null) {
    const playbook = defaultPlaybook();
    if (playbook) assignBrain(leadId, playbook.id, ctx.character.id);
  }

  switch (lead.stage) {
    case "fresh":
      return draftOutreach(lead, ctx);
    case "outreached":
      return followUpOrGiveUp(lead, ctx);
    case "replied":
      return runQualifyTurn(lead, ctx);
    default:
      return { kind: "skipped", reason: "This lead is waiting on a human review." };
  }
}

/** Draft an opener (or, with a nudge, a chase). No extraction — the lead hasn't spoken. */
async function draftOutreach(lead: LeadRow, ctx: Context, nudge?: string): Promise<StepResult> {
  const outcome = await generate(lead, ctx, nudge);
  if (outcome.kind !== "reply") {
    return { kind: "blocked", errors: outcome.errors };
  }

  const message = appendMessage({
    leadId: lead.id,
    channel: relayChannel(lead),
    direction: "outbound",
    body: outcome.reply,
    sentBy: "ai",
    sent: false,
  });
  if (!message) return { kind: "blocked", errors: ["Could not save the drafted message."] };

  // Nothing happens on the clock until the send is confirmed.
  clearDue(lead.id);
  return { kind: "drafted", message, final: false, ungrounded: outcome.ungrounded };
}

/** A lead who was contacted and hasn't replied: chase, or give up. */
async function followUpOrGiveUp(lead: LeadRow, ctx: Context): Promise<StepResult> {
  const followUpsSent = Math.max(0, aiMessagesSent(lead.id) - 1); // minus the opener
  const { count } = ctx.playbook.followUp;

  if (count > 0 && followUpsSent < count) {
    return draftOutreach(
      lead,
      ctx,
      "The lead hasn't replied to your previous message. Send a short, friendly follow-up that"
        + " references it and makes it easy to respond — don't repeat it word for word.",
    );
  }

  // Out of chases. "Never replied" goes straight to Closed, skipping human
  // review: there is no AI verdict to agree or disagree with.
  const summary = "No reply to any message in the sequence.";
  setDecision(lead.id, "rejected", summary);
  clearDue(lead.id);
  claimStage(lead.id, NON_TERMINAL, "disqualified", { requireAiEnabled: true });
  return { kind: "decided", verdict: "rejected", summary, label: "Never replied" };
}

/** One qualification turn against a real inbound message. */
async function runQualifyTurn(lead: LeadRow, ctx: Context): Promise<StepResult> {
  const outcome = await generate(lead, ctx);
  if (outcome.kind === "blocked") {
    setLeadError(lead.id, outcome.errors.join(" "));
    return { kind: "blocked", errors: outcome.errors };
  }

  saveConversationState(lead.id, outcome.collected, lead.turn_count + 1);

  const message = appendMessage({
    leadId: lead.id,
    channel: relayChannel(lead),
    direction: "outbound",
    body: outcome.reply,
    sentBy: "ai",
    sent: false,
  });
  if (!message) return { kind: "blocked", errors: ["Could not save the drafted message."] };
  clearDue(lead.id);

  const ending = endReason(lead, ctx, outcome);
  if (ending) {
    const decision = buildDecision(outcome.collected, ending.verdict, ending.reason);
    setDecision(lead.id, decision.verdict, decision.summary);
    // Send this last reply first; the decision is already waiting when they do.
    claimStage(lead.id, NON_TERMINAL, "decision", { requireAiEnabled: true });
  }

  return {
    kind: "drafted",
    message,
    final: Boolean(ending),
    ungrounded: outcome.ungrounded,
  };
}

/**
 * Whether this turn ends the conversation, and how.
 *
 * The model decides the qualified case (handoff, per the playbook); intent
 * covers the human-request and decline cases; and two deterministic backstops —
 * every target captured, or the message cap — stop it running forever if the
 * model never signals. All land in the Decision column for a human to confirm.
 */
function endReason(
  lead: LeadRow,
  ctx: Context,
  outcome: Extract<TurnOutcome, { kind: "reply" }>,
): { verdict: "qualified" | "rejected"; reason: string } | null {
  if (outcome.leadIntent === "not_interested") {
    return { verdict: "rejected", reason: handoffReason("not_interested")! };
  }
  if (outcome.leadIntent === "wants_human") {
    return { verdict: "qualified", reason: handoffReason("wants_human")! };
  }
  if (outcome.handoff) {
    return { verdict: "qualified", reason: "The AI judged it had learned enough to hand over." };
  }
  const allCaptured =
    ctx.targets.length > 0 &&
    ctx.targets.every((c) => {
      const v = outcome.collected[c.key];
      return typeof v === "string" && v.trim();
    });
  if (allCaptured) {
    return { verdict: "qualified", reason: "Every qualification criterion was answered." };
  }
  if (aiMessagesSent(lead.id) + 1 >= ctx.playbook.maxAiMessages) {
    return {
      verdict: "qualified",
      reason: `Reached the ${ctx.playbook.maxAiMessages}-message limit.`,
    };
  }
  return null;
}

/** One model turn. Shared by openers, chases and qualification. */
async function generate(lead: LeadRow, ctx: Context, nudge?: string): Promise<TurnOutcome> {
  const history = listMessages(lead.id)
    .filter((m) => m.sent_at && m.body)
    .map((m) => ({
      role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const),
      content: m.body as string,
    }));

  try {
    const provider = llmFor(providerConfigFor(ctx.character.connection_id));
    return await runTurn(provider, {
      playbook: ctx.playbook,
      criteria: ctx.criteria,
      targets: ctx.targets,
      character: toCharacterSpec(ctx.character),
      lead: {
        firstName: lead.first_name,
        companyWebsite: lead.company_website,
        expectedVolume: lead.expected_volume,
      },
      collected: leadCollected(lead) as Record<string, string>,
      messagesSent: aiMessagesSent(lead.id),
      history,
      promptLayer: loadPromptLayer(),
      language: lead.language,
      nudge,
    });
  } catch (e) {
    const message = (e as Error).message;
    setLeadError(lead.id, message);
    return { kind: "blocked", errors: [message], collected: {}, attempts: 0 };
  }
}

// ─── Sending, and replies ────────────────────────────────────────────────────

/**
 * Record that a drafted message was relayed, and set the follow-up clock.
 *
 * The opener sends the lead into "outreached" with a chase scheduled; a mid-
 * conversation reply just clears the clock, because the lead — not the timer —
 * drives what happens next.
 */
export function confirmSent(messageId: number, leadId: number): boolean {
  const sent = markMessageSent(messageId);
  if (!sent) return false;

  const lead = getLead(leadId);
  if (!lead) return true;

  if (!lead.first_outreach_at) {
    markFirstOutreach(leadId);
    // Register the conversation on the allowlist even though a manual channel
    // has no inbound feed to filter. It's what makes revocation at a terminal
    // stage mean something for these leads too, and keeps one auditable record
    // of every conversation the tool has been party to.
    addThread(leadId, relayChannel(lead), manualThreadId(leadId));
  }

  claimStage(leadId, ["fresh"], "outreached");

  const fresh = getLead(leadId)!;
  if (fresh.stage === "outreached") {
    // Waiting on a reply. Schedule the next chase (or the give-up check) after
    // the configured gap.
    const ctx = loadContext(fresh);
    const days = ctx?.playbook.followUp.everyDays ?? 3;
    setNextDue(leadId, days * DAY_MINUTES);
  } else {
    // Mid-qualification (already "replied") or finished — the clock doesn't drive it.
    clearDue(leadId);
  }
  return true;
}

/**
 * A reply arrived: record it, move the lead to "replied", and let the AI take
 * its turn (unless a human has taken over, in which case it's just logged).
 */
export async function recordInboundReply(leadId: number, text: string): Promise<StepResult> {
  const lead = getLead(leadId);
  if (!lead) return { kind: "skipped", reason: "That lead no longer exists." };
  if (TERMINAL_STAGES.includes(lead.stage)) {
    return { kind: "skipped", reason: "This lead is finished." };
  }
  const body = text.trim();
  if (!body) return { kind: "skipped", reason: "Paste what the lead said first." };
  if (pendingDraft(leadId)) {
    return {
      kind: "skipped",
      reason: "Send or discard the waiting message before logging a reply.",
    };
  }

  appendMessage({
    leadId,
    channel: relayChannel(lead),
    direction: "inbound",
    body,
    sentBy: "lead",
  });

  // The reply, not the clock, drives what happens next.
  claimStage(leadId, ["fresh", "outreached", "replied"], "replied");
  clearDue(leadId);

  if (lead.ai_enabled === 0) {
    return { kind: "skipped", reason: "Reply saved. The AI is off for this lead." };
  }
  return runStep(leadId);
}

/** Older names, kept so the existing UI actions don't all have to change at once. */
export const advanceConversation = runStep;
export const recordManualReply = recordInboundReply;
