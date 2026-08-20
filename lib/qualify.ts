/**
 * The conversation engine: one AI turn, from inbound message to outbound reply.
 *
 * Channel-agnostic on purpose. The manual relay and (soon) the email poller both
 * funnel into runTurn() with a transcript and get back a reply plus signals —
 * neither knows anything about playbooks or models.
 *
 * The model runs the conversation itself now, following the playbook prose. This
 * file no longer plans which question to ask; it builds the prompt, generates,
 * validates against the guardrails, grounds the extracted facts, and reports
 * what the lead seems to want. What to *do* with a handoff or a decline is the
 * caller's decision (lib/conversation.ts).
 */

import {
  extractionFields,
  type Criterion,
  type CriteriaRegistry,
} from "./criteria";
import {
  groundExtracted,
  turnResponseSchema,
  validateTurnResponse,
  type CharacterSpec,
  type Collected,
  type LeadContext,
  type LeadIntent,
  type TurnResponse,
} from "./playbook";
import type { PlaybookSpec } from "./playbookSpec";
import {
  DEFAULT_PROMPT_LAYER,
  neverSayList,
  renderSystemPrompt,
  type PromptLayer,
} from "./prompt";
import type { LlmProvider } from "./llm";

export interface TurnInput {
  playbook: PlaybookSpec;
  /** The full glossary, so {{criterion}} tokens resolve everywhere. */
  criteria: CriteriaRegistry;
  /** The subset this playbook tries to capture — taught inline in the prompt. */
  targets: Criterion[];
  character: CharacterSpec;
  lead: LeadContext;
  collected: Collected;
  /** AI messages already sent in this conversation, for the message cap. */
  messagesSent: number;
  /** The conversation so far. "user" is the lead, "assistant" is us. */
  history: { role: "user" | "assistant"; content: string }[];
  /** The general instructions governing every character, from the Brain. */
  promptLayer?: PromptLayer;
  /** The lead's own language once known; mirrors it. */
  language?: string | null;
  /**
   * A synthetic instruction to send when there's no inbound to react to — a
   * chase message on a lead who hasn't replied. Treated like an opener: a reply
   * is produced, but nothing is extracted (the lead said nothing).
   */
  nudge?: string;
}

export type TurnOutcome =
  | {
      kind: "reply";
      reply: string;
      collected: Collected;
      leadIntent: LeadIntent;
      /** The AI judged it has learned enough and a human should take over. */
      handoff: boolean;
      attempts: number;
      /** Facts the model claimed that the lead's message didn't support. */
      ungrounded?: string[];
    }
  | { kind: "blocked"; errors: string[]; collected: Collected; attempts: number };

const MAX_ATTEMPTS = 2;

/**
 * Run one turn.
 *
 * A response that fails the guardrails is retried once with the specific
 * complaints fed back — small models usually fix a length or placeholder
 * problem when told exactly what was wrong. A second failure returns "blocked"
 * rather than sending something dubious; the lead surfaces for a human instead.
 * Failing closed is the whole point of guardrails when sending is autonomous.
 */
export async function runTurn(provider: LlmProvider, input: TurnInput): Promise<TurnOutcome> {
  const { playbook, criteria, targets, character, lead, collected, history, language } = input;
  const layer = input.promptLayer ?? DEFAULT_PROMPT_LAYER;
  const banned = neverSayList(layer);

  const isOpening = history.length === 0;
  const nudge = input.nudge?.trim();
  // Opener and chase messages both react to nothing the lead said, so neither
  // extracts. Only a real inbound turn does.
  const noInbound = isOpening || Boolean(nudge);
  const lastInbound = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  const fields = extractionFields(targets);
  const schema = turnResponseSchema(fields);

  // A model needs something to respond to. Opening has no inbound at all; a chase
  // appends the nudge as the thing to act on.
  const messages = isOpening
    ? [
        {
          role: "user" as const,
          content:
            "(They have just submitted the application form and you are opening the conversation.)",
        },
      ]
    : nudge
      ? [...history, { role: "user" as const, content: `(${nudge})` }]
      : history;

  const system = renderSystemPrompt({
    layer,
    character,
    lead,
    playbook: { instructions: playbook.instructions, defaultLanguage: playbook.defaultLanguage },
    targets,
    collected,
    isFirstMessage: isOpening,
    language,
    criteria,
  });

  let lastErrors: string[] = [];
  let value: TurnResponse | null = null;
  let attempts = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attempts++;
    const retryNote = lastErrors.length
      ? `\n\nYour previous attempt was rejected:\n${lastErrors.map((e) => `- ${e}`).join("\n")}\nWrite it again, fixing exactly those problems.`
      : "";

    const raw = await provider.complete({
      system: system + retryNote,
      messages,
      schema,
      maxTokens: 800,
    });

    const check = validateTurnResponse(fields, character, raw, banned);
    if (check.ok) {
      value = check.value;
      break;
    }
    lastErrors = check.errors;
  }

  if (!value) {
    return { kind: "blocked", errors: lastErrors, collected, attempts };
  }

  // On an opener or a chase the lead has not said anything, so neither "what
  // they stated" nor "what they intend" can be meaningful. Discard both rather
  // than trusting the model's guess: small models reliably mine the context
  // block instead, reporting the company website as a scraping target and the
  // form's volume band as something the lead just told them.
  if (noInbound) {
    return {
      kind: "reply",
      reply: value.reply,
      collected,
      leadIntent: "answering",
      handoff: false,
      attempts,
    };
  }

  // Keep only facts the lead's own message supports.
  const { kept, dropped } = groundExtracted(fields, value.extracted, lastInbound);

  const working: Collected = { ...collected };
  let learnedSomething = false;
  for (const [k, v] of Object.entries(kept)) {
    // First answer wins — a later restatement shouldn't overwrite the original.
    if (v && !working[k]) {
      working[k] = v;
      learnedSomething = true;
    }
  }

  const intent = resolveIntent(value.leadIntent, lastInbound, learnedSomething);

  return {
    kind: "reply",
    reply: value.reply,
    collected: working,
    leadIntent: intent,
    handoff: value.handoff,
    attempts,
    ungrounded: dropped.length ? [...new Set(dropped)] : undefined,
  };
}

const ASKS_FOR_HUMAN =
  /\bhumans?\b|\b(real|actual) person\b|\bspeak (to|with) (someone|somebody|a person)\b|\btalk to (someone|somebody|a person)\b/i;

/**
 * Decide what the lead actually meant, correcting the model where we have
 * better evidence than it does.
 *
 *  - We told the lead to reply HUMAN, so look for that ourselves rather than
 *    relying on the model to notice. Erring toward a human is the safe direction.
 *  - A lead who just answered the question is engaged, whatever the classifier
 *    said. Small models return "not_interested" for plainly cooperative replies;
 *    without this, the first real answer would end the conversation.
 */
export function resolveIntent(
  modelIntent: LeadIntent,
  lastInbound: string,
  learnedSomething: boolean,
): LeadIntent {
  if (ASKS_FOR_HUMAN.test(lastInbound)) return "wants_human";
  if (modelIntent === "not_interested" && learnedSomething) return "answering";
  return modelIntent;
}

/** A short reason for ending the conversation, when the lead's intent ends it. */
export function handoffReason(intent: LeadIntent): string | undefined {
  if (intent === "wants_human") return "The lead asked to speak to a person.";
  if (intent === "not_interested") return "The lead said they aren't interested.";
  return undefined;
}

/**
 * The Stage 4 verdict and the sentence explaining it.
 *
 * Deliberately not another model call: the facts are already structured in
 * `collected`, and paraphrasing them through a small model would only introduce
 * drift into the one artefact a human is meant to trust. The summary is
 * narrative only — the collected facts are rendered alongside it.
 */
export function buildDecision(
  collected: Collected,
  verdict: "qualified" | "rejected",
  reason: string,
): { verdict: "qualified" | "rejected"; summary: string } {
  const answered = Object.values(collected).filter(
    (v) => typeof v === "string" && v.trim(),
  ).length;

  const summary =
    answered === 0
      ? `${reason} The lead didn't answer any qualification questions.`
      : reason;

  return { verdict, summary: summary.trim() };
}
