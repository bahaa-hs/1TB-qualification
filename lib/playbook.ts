/**
 * The turn contract and guardrails: what a single AI turn must produce, and how
 * we check it before anything reaches a prospect.
 *
 * This used to also hold a turn *planner* that scripted one question per turn.
 * That's gone — the playbook is prose now (lib/playbookSpec.ts) and the model
 * runs the conversation itself. What remains is the part that never trusted the
 * model: the JSON contract, and the validation that fails closed.
 *
 * With autonomous sending on, this validation is the only thing between a bad
 * generation and a prospect's inbox, so it rejects anything unexpected rather
 * than cleaning it up. Everything here is pure. See lib/__tests__/playbook.test.ts.
 */

// ─── Character & context ─────────────────────────────────────────────────────

export interface CharacterSpec {
  name: string;
  persona: string;
  signature?: string;
  maxWords?: number;
  emoji?: boolean;
}

export type Collected = Record<string, string | null | undefined>;

export interface LeadContext {
  firstName?: string | null;
  companyWebsite?: string | null;
  expectedVolume?: string | null;
}

/**
 * Fallback word cap for a character that doesn't set one. One constant because
 * this default previously appeared in several places with two different values.
 */
export const DEFAULT_MAX_WORDS = 120;

export const LEAD_INTENTS = [
  "answering",
  "asking_question",
  "not_interested",
  "wants_human",
] as const;
export type LeadIntent = (typeof LEAD_INTENTS)[number];

// ─── The extraction target ───────────────────────────────────────────────────

/**
 * One fact the turn may capture. Built from the criteria the playbook targets —
 * the schema, the validator and the grounding all work off this minimal shape
 * rather than the full glossary type.
 */
export interface ExtractionField {
  key: string;
  /** Fixed answer tokens (a "choice" criterion). Free text when absent. */
  options?: string[];
  /** Human description, used as the JSON Schema field description. */
  description?: string;
}

// ─── The model contract ──────────────────────────────────────────────────────

export interface TurnResponse {
  extracted: Record<string, string | null>;
  reply: string;
  leadIntent: LeadIntent;
  /** The AI judges it has learned enough (or should) and a human should take over. */
  handoff: boolean;
}

/**
 * JSON Schema the model's response must satisfy.
 *
 * Every field key is present and nullable rather than optional: OpenAI's strict
 * json_schema mode requires all properties listed as required, and "return null
 * when you don't know" is a clearer instruction to a small model than "omit it".
 */
export function turnResponseSchema(fields: ExtractionField[]): object {
  const properties: Record<string, object> = {};
  for (const f of fields) {
    properties[f.key] = f.options?.length
      ? { type: ["string", "null"], enum: [...f.options, null], description: f.description ?? f.key }
      : { type: ["string", "null"], description: f.description ?? f.key };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["extracted", "reply", "leadIntent", "handoff"],
    properties: {
      extracted: {
        type: "object",
        additionalProperties: false,
        required: fields.map((f) => f.key),
        properties,
        description: "Facts stated by the lead in their latest message. null if not stated.",
      },
      reply: {
        type: "string",
        description: "The message to send to the lead. Plain text, no placeholders.",
      },
      leadIntent: { type: "string", enum: [...LEAD_INTENTS] },
      handoff: {
        type: "boolean",
        description: "true once you've learned enough to hand this lead to a human, or should.",
      },
    },
  };
}

// ─── Guardrails ──────────────────────────────────────────────────────────────

/**
 * Signs a generation is not fit to send: an unfilled template, the model
 * breaking character, or a refusal leaking through.
 */
const PLACEHOLDER_PATTERNS: [RegExp, string][] = [
  [/\{\{|\}\}/, "contains an unfilled {{template}} placeholder"],
  [/\[(insert|your name|name|company|link|todo)\b[^\]]*\]/i, "contains an unfilled [placeholder]"],
  [/\bas an ai\b|\bas a language model\b|\bi'?m an ai (language )?model\b/i,
    "breaks character by referring to itself as a language model"],
  [/\bI cannot\b.*\bas an\b/i, "looks like a refusal rather than a reply"],
  [/^(sure|certainly|okay)[,!]? here'?s\b/i, "starts with an assistant preamble instead of the message"],
  // Observed live: llama3.1:8b answered a handoff turn with the literal text
  // "LeadIntent: human_requested" — the response format bleeding into the body.
  [/\b(leadintent|thenhandoff|turnresponse)\b/i, "leaked a field name from the response format"],
  [
    /^\s*\w+\s*[:=]\s*(answering|asking_question|not_interested|wants_human|human_requested)\s*[.!]?\s*$/i,
    "is a bare field value rather than a message",
  ],
  [/^\s*\{[\s\S]*\}\s*$/, "is raw JSON rather than a message"],
];

export type TurnValidation =
  | { ok: true; value: TurnResponse }
  | { ok: false; errors: string[] };

/**
 * Validate a model response before anything is sent. Fails closed: anything
 * unexpected is rejected rather than cleaned up and sent anyway.
 */
export function validateTurnResponse(
  fields: ExtractionField[],
  character: CharacterSpec,
  raw: unknown,
  /** Phrases from the Brain's never-say list. Plain substrings, not regexes. */
  neverSay: string[] = [],
): TurnValidation {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["The model did not return a JSON object."] };
  }
  const r = raw as Record<string, unknown>;

  const reply = typeof r.reply === "string" ? r.reply.trim() : "";
  if (!reply) errors.push("The model returned an empty reply.");

  const maxWords = character.maxWords ?? DEFAULT_MAX_WORDS;
  const words = reply ? reply.split(/\s+/).length : 0;
  if (words > maxWords) {
    errors.push(`Reply is ${words} words, over ${character.name}'s ${maxWords}-word limit.`);
  }
  for (const [re, why] of PLACEHOLDER_PATTERNS) {
    if (re.test(reply)) errors.push(`Reply ${why}.`);
  }
  const lower = reply.toLowerCase();
  for (const phrase of neverSay) {
    if (lower.includes(phrase.toLowerCase())) {
      errors.push(`Reply contains "${phrase}", which is on the never-say list.`);
    }
  }
  if (character.emoji === false && /\p{Extended_Pictographic}/u.test(reply)) {
    errors.push(`Reply uses emoji, which ${character.name} is configured not to.`);
  }

  const intent = r.leadIntent;
  if (typeof intent !== "string" || !LEAD_INTENTS.includes(intent as LeadIntent)) {
    errors.push(`leadIntent "${String(intent)}" is not one of: ${LEAD_INTENTS.join(", ")}.`);
  }

  // handoff is coerced rather than rejected: a small model omitting a boolean
  // shouldn't block an otherwise-good message. Missing/garbage means "not yet".
  const handoff = r.handoff === true;

  const extracted: Record<string, string | null> = {};
  const rawExtracted = r.extracted;
  if (rawExtracted !== undefined && rawExtracted !== null) {
    if (typeof rawExtracted !== "object") {
      errors.push("extracted must be an object.");
    } else {
      const byKey = new Map(fields.map((f) => [f.key, f]));
      for (const [k, v] of Object.entries(rawExtracted as Record<string, unknown>)) {
        const field = byKey.get(k);
        // A hallucinated key means the model invented a field. Reject rather
        // than drop it — it usually means the whole response drifted.
        if (!field) {
          errors.push(`extracted contains "${k}", which is not a tracked criterion.`);
          continue;
        }
        if (v === null || v === undefined || v === "") continue;
        if (typeof v !== "string") {
          errors.push(`extracted.${k} must be a string or null.`);
          continue;
        }
        if (field.options?.length && !field.options.includes(v)) {
          errors.push(`extracted.${k} is "${v}", which is not one of: ${field.options.join(", ")}.`);
          continue;
        }
        extracted[k] = v;
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { extracted, reply, leadIntent: intent as LeadIntent, handoff } };
}

// ─── Grounding ───────────────────────────────────────────────────────────────

const normalise = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const tokens = (s: string): string[] =>
  normalise(s).split(" ").filter((t) => t.length >= 2);

/**
 * Drop "extracted" facts the lead never actually said.
 *
 * Prompting alone does not stop a small model mining the context block. A
 * fabricated fact is worse than a missing one: it lands in the decision summary
 * a human then acts on, and nothing about it looks wrong.
 *
 * Only free-text answers are checked. Values from an `options` list are already
 * bounded by the enum, and a canonical token like "web_scraping" won't appear
 * verbatim in "we do web scraping". A false rejection just re-asks — the cheap
 * direction to be wrong in.
 */
export function groundExtracted(
  fields: ExtractionField[],
  extracted: Record<string, string | null>,
  leadSaid: string,
): { kept: Record<string, string | null>; dropped: string[] } {
  const haystack = tokens(leadSaid);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const kept: Record<string, string | null> = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(extracted)) {
    if (!value) continue;
    const field = byKey.get(key);
    if (!field || field.options?.length) {
      kept[key] = value;
      continue;
    }
    const needles = tokens(value);
    if (needles.length === 0) {
      kept[key] = value;
      continue;
    }
    const hits = needles.filter((n) => haystack.includes(n)).length;
    if (hits / needles.length >= 0.6) kept[key] = value;
    else dropped.push(`${key}="${value}"`);
  }
  return { kept, dropped };
}

// ─── A sensible default character ────────────────────────────────────────────

export const DEFAULT_CHARACTER: CharacterSpec = {
  name: "Sam",
  persona: [
    "Warm, direct and concise — the way a good technical salesperson writes.",
    "Plain English, contractions, no corporate filler and no exclamation marks.",
    "Genuinely curious about what the person is building rather than pushy.",
  ].join(" "),
  signature: "Sam, Geonode",
  maxWords: 90,
  emoji: false,
};
