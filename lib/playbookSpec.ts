/**
 * The playbook: free-text instructions the AI follows to run a conversation.
 *
 * This replaces the old drag-and-drop workflow graph. A playbook used to be a
 * graph of send/wait/qualify/decision nodes that the app walked one scripted
 * question at a time. Now it's prose the model reads and follows — how to open,
 * what to learn, when to hand off — plus a short list of which glossary criteria
 * to try to capture, a safety cap, and a follow-up cadence.
 *
 * The facts still matter (they drive scoring and the board), but they're
 * captured loosely as the conversation happens rather than asked in a fixed
 * order. The criteria vocabulary lives in lib/criteria.ts; this file only names
 * which of them a given playbook cares about.
 *
 * Everything here is pure and safe to import from a client component. Storage
 * lives in lib/brain.ts (playbooks.spec JSON), which touches the database.
 */

// ─── Shape ───────────────────────────────────────────────────────────────────

export interface FollowUp {
  /** How many chase messages to send if the lead never replies. 0 = none. */
  count: number;
  /** Days to wait between the opener/each follow-up. */
  everyDays: number;
}

export interface PlaybookSpec {
  name: string;
  version: 3;
  /** The free-text instructions the AI follows — the heart of the playbook. */
  instructions: string;
  /**
   * Which glossary criteria this playbook tries to capture. Empty = every
   * criterion in the registry. Keys must exist in the criteria registry.
   */
  criteriaKeys: string[];
  /** Hard cap on AI messages in one conversation, so it can't run forever. */
  maxAiMessages: number;
  /** Chase cadence for a lead who hasn't replied. */
  followUp: FollowUp;
  /**
   * Language for the opening message, before the lead has written anything.
   * Empty means "the lead's own language, defaulting to English". Once the lead
   * replies the AI mirrors their language regardless.
   */
  defaultLanguage: string;
}

export const DEFAULT_MAX_AI_MESSAGES = 20;

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate a playbook authored in the UI. Returns every problem at once so the
 * editor can show them together.
 *
 * `knownKeys` is the set of criterion keys that currently exist; pass it so a
 * playbook can't reference a criterion that was renamed or deleted. Omit it to
 * skip that check (e.g. when validating a stand-alone import before the
 * registry is loaded).
 */
export function validatePlaybook(spec: PlaybookSpec, knownKeys?: Set<string>): string[] {
  const errors: string[] = [];
  if (!spec.name?.trim()) errors.push("Give the playbook a name.");
  if (!spec.instructions?.trim()) errors.push("Write the instructions the AI should follow.");

  if (!Number.isInteger(spec.maxAiMessages) || spec.maxAiMessages < 1 || spec.maxAiMessages > 100) {
    errors.push("The message cap must be a whole number between 1 and 100.");
  }

  if (!Number.isInteger(spec.followUp?.count) || spec.followUp.count < 0 || spec.followUp.count > 20) {
    errors.push("Follow-ups must be a whole number between 0 and 20.");
  }
  if (spec.followUp?.count > 0) {
    if (!Number.isInteger(spec.followUp.everyDays) || spec.followUp.everyDays < 1) {
      errors.push("The gap between follow-ups must be at least 1 day.");
    }
  }

  if (knownKeys) {
    for (const key of spec.criteriaKeys ?? []) {
      if (!knownKeys.has(key)) {
        errors.push(`The playbook targets "${key}", which is not a qualification criterion.`);
      }
    }
  }

  return errors;
}

// ─── Normalisation & upgrade ─────────────────────────────────────────────────

const DAY_MINUTES = 60 * 24;

/** Old flat playbook (v1) and workflow graph (v2) shapes, read-only for upgrade. */
interface OldObjective {
  key?: string;
  question?: string;
}
interface OldStep {
  type?: string;
  objectives?: OldObjective[];
  brief?: string;
  delayMinutes?: number;
}
interface OldSpec {
  name?: string;
  version?: number;
  instructions?: string;
  criteriaKeys?: string[];
  maxAiMessages?: number;
  followUp?: Partial<FollowUp>;
  defaultLanguage?: string;
  steps?: OldStep[];
  objectives?: OldObjective[];
}

/**
 * Coerce anything read from storage into a valid v3 playbook.
 *
 * A v3 spec is returned normalised (missing fields filled). A v1 flat playbook
 * or v2 graph is converted to prose in memory; the next save writes v3. Same
 * lazy-on-read approach the graph used — nothing to half-apply, and an old
 * export imported months from now still works.
 */
export function upgradeSpec(raw: unknown): PlaybookSpec {
  const spec = (raw ?? {}) as OldSpec;

  if (spec.version === 3 && typeof spec.instructions === "string") {
    return normalise(spec);
  }

  // v2 graph → gather the qualification questions and the chase cadence.
  if (spec.version === 2 && Array.isArray(spec.steps)) {
    const objectives: OldObjective[] = [];
    let followUpCount = 0;
    let gapMinutes = 0;
    for (const step of spec.steps) {
      if (step?.type === "qualify" && Array.isArray(step.objectives)) {
        objectives.push(...step.objectives);
      }
      if (step?.type === "outreach" && step.brief) {
        // Follow-up outreach steps carry a brief; the opener doesn't.
        followUpCount++;
        if (!gapMinutes && step.delayMinutes) gapMinutes = step.delayMinutes;
      }
    }
    return normalise({
      name: spec.name || "Proxy qualification",
      instructions: proseFromObjectives(objectives),
      criteriaKeys: keysOf(objectives),
      followUp: {
        count: followUpCount || DEFAULT_PLAYBOOK.followUp.count,
        everyDays: gapMinutes ? Math.max(1, Math.round(gapMinutes / DAY_MINUTES)) : 3,
      },
    });
  }

  // v1 flat playbook → its objectives become the instructions.
  if (Array.isArray(spec.objectives)) {
    return normalise({
      name: spec.name || "Proxy qualification",
      instructions: proseFromObjectives(spec.objectives),
      criteriaKeys: keysOf(spec.objectives),
    });
  }

  // Unrecognisable (e.g. {} on first seed) → the shipped default.
  return { ...DEFAULT_PLAYBOOK, name: spec.name || DEFAULT_PLAYBOOK.name };
}

function keysOf(objectives: OldObjective[]): string[] {
  const seen = new Set<string>();
  for (const o of objectives) if (o.key) seen.add(o.key);
  return [...seen];
}

function proseFromObjectives(objectives: OldObjective[]): string {
  const lines = objectives
    .map((o) => o.question?.trim())
    .filter(Boolean)
    .map((q) => `- ${q}`);
  return [
    "You're qualifying an inbound sales lead. Open with a short, human introduction that",
    "references their application and asks an open question about what they're working on.",
    "",
    "Over the conversation, learn — naturally, one thing at a time, never as a checklist:",
    ...(lines.length ? lines : ["- what they're planning to use the product for"]),
    "",
    "Acknowledge what they say before asking the next thing. Hand off to a human once you",
    "understand enough to judge the fit, or straight away if they ask for a person. If they're",
    "clearly out of scope, thank them warmly and let them know it isn't a fit.",
  ].join("\n");
}

function normalise(spec: OldSpec): PlaybookSpec {
  return {
    name: (spec.name || "Proxy qualification").trim(),
    version: 3,
    instructions: (spec.instructions ?? "").trim(),
    criteriaKeys: Array.isArray(spec.criteriaKeys) ? spec.criteriaKeys.filter(Boolean) : [],
    maxAiMessages:
      Number.isInteger(spec.maxAiMessages) && spec.maxAiMessages! > 0
        ? spec.maxAiMessages!
        : DEFAULT_MAX_AI_MESSAGES,
    followUp: {
      count: Number.isInteger(spec.followUp?.count) ? spec.followUp!.count! : DEFAULT_PLAYBOOK.followUp.count,
      everyDays:
        Number.isInteger(spec.followUp?.everyDays) && spec.followUp!.everyDays! > 0
          ? spec.followUp!.everyDays!
          : DEFAULT_PLAYBOOK.followUp.everyDays,
    },
    defaultLanguage: (spec.defaultLanguage ?? "").trim(),
  };
}

// ─── The shipped default ─────────────────────────────────────────────────────

export const DEFAULT_PLAYBOOK: PlaybookSpec = {
  name: "Proxy qualification",
  version: 3,
  instructions: [
    "You're doing inbound sales qualification for Geonode, a proxy provider. The lead applied",
    "through the form and you're reaching out to understand what they need.",
    "",
    "Opening message: introduce yourself briefly, reference that they applied, and ask an open",
    "question about what they're building. Keep it short and human — no pitch yet.",
    "",
    "Over the next few replies, learn — conversationally, one thing at a time, never as a",
    "checklist:",
    "- what they want to use proxies for",
    "- which sites or platforms they're targeting (only if they're scraping)",
    "- roughly how much traffic they expect per month",
    "- when they're looking to start",
    "- whether they already use another proxy provider",
    "",
    "Acknowledge what they just said before asking the next thing. Ask one thing at a time.",
    "",
    "Hand off to a human once you understand their use case, rough volume and timeline — or",
    "immediately if they ask for a person. If their use case is clearly outside what Geonode",
    "does, thank them and let them know warmly that it isn't a fit.",
  ].join("\n"),
  criteriaKeys: ["use_case", "target_sites", "monthly_volume", "timeline", "current_provider"],
  maxAiMessages: DEFAULT_MAX_AI_MESSAGES,
  followUp: { count: 2, everyDays: 3 },
  defaultLanguage: "",
};
