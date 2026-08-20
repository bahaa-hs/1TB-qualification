/**
 * The system-prompt layer: the general instructions that govern every character.
 *
 * This used to be string literals inside buildSystemPrompt(), which meant the
 * only way to change what the AI was told was to edit TypeScript — and worse,
 * a hardcoded `You must…` line silently overrode anything written in a
 * character's Voice. Now it's editable text in the Brain, and the code only
 * assembles it.
 *
 * The split is deliberate:
 *
 *   EDITABLE   identity, knowledge, rules, opening, neverSay
 *   AUTOMATIC  the character's voice, the lead's details, what's been
 *              established, the question for this turn, the word/emoji limits,
 *              and the instruction to answer as JSON
 *
 * The automatic parts are derived from data you already control elsewhere (the
 * character, the playbook, the lead) or are load-bearing for the machinery. The
 * editor shows both so the whole prompt is visible, not just the half you type.
 *
 * Everything here is pure and safe to import from a client component. Reading
 * and writing the layer lives in lib/promptStore.ts, which touches the database
 * and must not be pulled into the browser bundle.
 */

import type { CharacterSpec, Collected, LeadContext } from "./playbook";
import { DEFAULT_MAX_WORDS } from "./playbook";
import {
  criterionValues,
  valueLabel,
  findCriterion,
  type Criterion,
  type CriteriaRegistry,
} from "./criteria";

export interface PromptLayer {
  identity: string;
  knowledge: string;
  rules: string;
  opening: string;
  /** One phrase per line. A reply containing any of them is rejected. */
  neverSay: string;
}

export const PROMPT_KEYS = {
  identity: "prompt.identity",
  knowledge: "prompt.knowledge",
  rules: "prompt.rules",
  opening: "prompt.opening",
  neverSay: "prompt.neverSay",
} as const;

/**
 * The shipped defaults — verbatim what was hardcoded before, so behaviour is
 * identical until you edit something.
 */
export const DEFAULT_PROMPT_LAYER: PromptLayer = {
  identity: `You are {{character.name}}, qualifying an inbound sales lead for Geonode, a proxy provider.`,
  knowledge: `Geonode sells residential and datacenter proxies. Never invent facts about pricing, features or availability — if you're asked something you don't know, say a colleague will confirm.`,
  rules: [
    `- Write only the message body. No subject line, no "Here's my reply", no markdown headings.`,
    `- Acknowledge whatever they just said, then ask your question. One question only — do not stack several.`,
    `- Record in "extracted" ONLY facts the lead typed in their most recent message. Use null for everything else. Never copy from the application form, never infer, never guess.`,
    `- If they ask for a human, are hostile, or say they aren't interested, set leadIntent accordingly and keep your reply brief and gracious.`,
  ].join("\n"),
  opening: `This is your FIRST message. State plainly that you are an AI assistant, and tell them they can reply HUMAN at any point to speak to a person.`,
  neverSay: "",
};

/** Placeholders usable inside any editable section. Shown in the editor. */
export const PLACEHOLDERS: { token: string; describes: string }[] = [
  { token: "{{character.name}}", describes: "The character's name" },
  { token: "{{character.signature}}", describes: "Their sign-off" },
  { token: "{{character.maxWords}}", describes: "Their word limit" },
  { token: "{{lead.firstName}}", describes: "The lead's first name" },
  { token: "{{lead.company}}", describes: "Their company website, if given" },
  { token: "{{lead.volume}}", describes: "The traffic band they ticked on the form" },
];

/** Phrases the AI must not use, one per line, blanks ignored. */
export function neverSayList(layer: PromptLayer): string[] {
  return layer.neverSay
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─── Placeholder substitution ────────────────────────────────────────────────

/**
 * Every token the built-in half of the namespace understands.
 *
 * Criterion keys make up the other half, and the two can never collide:
 * CRITERION_KEY_RE forbids a dot and every built-in contains one.
 */
export function builtinPlaceholderKeys(): string[] {
  return PLACEHOLDERS.map((p) => p.token.replace(/[{}\s]/g, ""));
}

/**
 * A substituted value can never introduce a brace.
 *
 * Values come from the lead's own words, and the placeholder guardrail rejects
 * any `{{` in a reply — so a lead who pastes a template snippet into an email
 * must not be able to get their own conversation blocked. No legitimate name,
 * domain or answer contains a brace.
 */
const noBraces = (s: string) => s.replace(/[{}]/g, "");

export function fillPlaceholders(
  text: string,
  ctx: {
    character: CharacterSpec;
    lead: LeadContext;
    /** The glossary, so {{use_case}} resolves. Omit to fill built-ins only. */
    criteria?: CriteriaRegistry;
    collected?: Collected;
  },
): string {
  const values: Record<string, string> = {
    "character.name": ctx.character.name,
    "character.signature": ctx.character.signature ?? "",
    "character.maxWords": String(ctx.character.maxWords ?? DEFAULT_MAX_WORDS),
    "lead.firstName": ctx.lead.firstName || "there",
    "lead.company": ctx.lead.companyWebsite ?? "",
    "lead.volume": ctx.lead.expectedVolume ?? "",
    // A criterion this lead has no value for is deliberately absent, not blank:
    // its token survives, and buildPromptParts drops the line that mentions it.
    ...(ctx.criteria ? criterionValues(ctx.criteria, ctx.collected ?? {}) : {}),
  };
  // The charset takes digits and underscores so criterion keys resolve; the
  // leading letter mirrors CRITERION_KEY_RE, so {{1st}} stays literal rather
  // than half-matching. An unknown placeholder is left as written rather than
  // blanked, so a typo is visible in the preview instead of silently deleting
  // text — and rejected at save time, which is where it belongs.
  return text.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g, (whole, key: string) =>
    key in values ? noBraces(values[key]) : whole,
  );
}

/** Lines still holding a `{{token}}` after substitution, and which tokens. */
function pendingLines(text: string): { line: string; tokens: string[] }[] {
  return text
    .split("\n")
    .map((line) => ({
      line,
      tokens: [...new Set((line.match(/\{\{\s*[a-zA-Z][a-zA-Z0-9_.]*\s*\}\}/g) ?? []).map((t) => t.replace(/[{}\s]/g, "")))],
    }))
    .filter((l) => l.tokens.length > 0);
}

// ─── Assembly ────────────────────────────────────────────────────────────────

export interface PromptParts {
  /** Blocks the layer contributed, in order. */
  editable: { heading: string; body: string }[];
  /** Blocks the code contributes. Shown in the preview, not editable. */
  automatic: { heading: string; body: string }[];
  /**
   * Lines held back because a criterion they mention isn't known for this lead
   * yet. Returned rather than swallowed so the preview can show them struck
   * through — silent line-dropping would be baffling, visible line-dropping is
   * the feature.
   */
  waiting: { line: string; tokens: string[] }[];
}

/**
 * Build the prompt as labelled blocks, so the editor can show exactly what will
 * be sent and which half came from where. renderSystemPrompt() flattens it.
 */
export function buildPromptParts(args: {
  layer: PromptLayer;
  character: CharacterSpec;
  lead: LeadContext;
  /** The prose the AI follows, plus the language to open in. */
  playbook: { instructions: string; defaultLanguage?: string };
  /** The criteria this playbook tries to capture — the glossary, taught inline. */
  targets: Criterion[];
  collected: Collected;
  isFirstMessage: boolean;
  /** The lead's own language once known. Overrides the playbook default. */
  language?: string | null;
  /** The full glossary, so {{criterion}} tokens resolve. Omit to leave them alone. */
  criteria?: CriteriaRegistry;
}): PromptParts {
  const { layer, character, lead, playbook, targets, collected, isFirstMessage, language, criteria } =
    args;
  const waiting: { line: string; tokens: string[] }[] = [];

  /**
   * Substitute, then drop any line still holding a token.
   *
   * A brief saying "they said {{use_case}} — ask which sites" is written to be
   * true once use_case is known. Before then, resolving it to an empty string
   * produces "they said ." — not merely awkward, but confidently wrong, and a
   * small model will invent a filler to repair the sentence. The sentence was
   * conditional on knowing the value, so if we don't know it, it isn't there.
   */
  const fill = (t: string) => {
    const filled = fillPlaceholders(t, { character, lead, criteria, collected });
    if (!criteria) return filled.trim();
    const pending = pendingLines(filled);
    if (!pending.length) return filled.trim();
    waiting.push(...pending);
    const held = new Set(pending.map((p) => p.line));
    return filled
      .split("\n")
      .filter((line) => !held.has(line))
      .join("\n")
      .trim();
  };

  const editable: { heading: string; body: string }[] = [];
  if (layer.identity.trim()) editable.push({ heading: "", body: fill(layer.identity) });
  if (layer.knowledge.trim()) editable.push({ heading: "WHAT YOU KNOW", body: fill(layer.knowledge) });

  const automatic: { heading: string; body: string }[] = [];

  const voice = [character.persona.trim(), character.signature ? `Sign off as: ${character.signature}` : ""]
    .filter(Boolean)
    .join("\n");
  automatic.push({ heading: "VOICE", body: voice });

  // fill() may drop every line (a conditional instruction whose criterion isn't
  // known yet), so push only when something survives — an empty heading is noise.
  const instructions = playbook.instructions.trim() ? fill(playbook.instructions) : "";
  if (instructions) automatic.push({ heading: "YOUR PLAYBOOK", body: instructions });

  const form = [
    `From their application form (background only — they have NOT said any of this to you in`,
    `conversation, so never record it as something they stated):`,
    `- Name: ${lead.firstName || "unknown"}`,
    lead.companyWebsite ? `- Company site: ${lead.companyWebsite}` : "",
    lead.expectedVolume ? `- Ticked the ${lead.expectedVolume} traffic band on the form` : "",
  ]
    .filter(Boolean)
    .join("\n");
  automatic.push({ heading: "THE LEAD", body: form });

  // Rendered with the criterion's own words where we have them — "Use case: Web
  // scraping" rather than "use_case: web_scraping". Braces are stripped because
  // free-text values are the lead's own words.
  const known = Object.entries(collected)
    .filter(([, v]) => typeof v === "string" && v.trim())
    .map(([k, v]) => {
      const c = criteria ? findCriterion(criteria, k) : null;
      return `- ${noBraces(c?.label ?? k)}: ${noBraces(valueLabel(c, String(v).trim()))}`;
    })
    .join("\n");
  if (known) automatic.push({ heading: "ESTABLISHED IN THIS CONVERSATION", body: known });

  // The glossary, taught inline. Each target criterion carries its meaning and,
  // for a choice, its allowed answers with definitions — a small model told what
  // seo_monitoring means picks it correctly where one left to guess coin-flips.
  const facts = targets
    .map((c) => {
      const currentRaw = collected[c.key];
      const current =
        typeof currentRaw === "string" && currentRaw.trim() ? valueLabel(c, currentRaw.trim()) : null;
      const desc = c.description?.trim() ? ` — ${c.description.trim()}` : "";
      const answers =
        c.kind === "choice"
          ? `\n    one of: ${(c.values ?? [])
              .map((v) => `${v.value}${v.definition ? ` (${v.definition})` : ""}`)
              .join("; ")}`
          : "";
      const state = current ? ` [already known: ${noBraces(current)}]` : "";
      return `- ${c.key}${desc}${answers}${state}`;
    })
    .join("\n");

  automatic.push({
    heading: "YOUR TASK THIS TURN",
    body: [
      "Continue the conversation, following your playbook above. Ask at most one thing this turn,",
      "and acknowledge what they just said first.",
      facts
        ? '\nIf the lead states any of these, record it under its key in "extracted" — only what they'
          + " actually said in their latest message, null for everything else:"
        : "",
      facts,
      "\nSet handoff to true once you've learned enough to pass this lead to a human, or if they ask for one.",
    ]
      .filter(Boolean)
      .join("\n"),
  });

  const lang = languageInstruction(language, playbook.defaultLanguage, isFirstMessage);
  if (lang) automatic.push({ heading: "LANGUAGE", body: lang });

  if (isFirstMessage && layer.opening.trim()) {
    editable.push({ heading: "THIS IS THE FIRST MESSAGE", body: fill(layer.opening) });
  }

  if (layer.rules.trim()) editable.push({ heading: "RULES", body: fill(layer.rules) });

  const limits = [
    `- Keep it under ${character.maxWords ?? DEFAULT_MAX_WORDS} words.`,
    character.emoji === false ? `- No emoji.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  automatic.push({ heading: "LIMITS", body: limits });

  const banned = neverSayList(layer);
  if (banned.length) {
    editable.push({
      heading: "NEVER SAY",
      body: banned.map((p) => `- ${p}`).join("\n"),
    });
  }

  automatic.push({ heading: "", body: "Respond with JSON matching the required schema." });

  return { editable, automatic, waiting };
}

/**
 * What language to reply in.
 *
 * Once the lead's own language is known we mirror it. Before then — the opening
 * message — we use the playbook's chosen language, falling back to matching the
 * lead and defaulting to English. The scaffolding around this prompt is English,
 * but that's instruction *to* the model, not the language of its output.
 */
function languageInstruction(
  language: string | null | undefined,
  defaultLanguage: string | undefined,
  isFirstMessage: boolean,
): string {
  const known = language?.trim();
  if (known) return `Write your reply in ${known}.`;
  const fallback = defaultLanguage?.trim();
  if (isFirstMessage && fallback) return `Write this first message in ${fallback}.`;
  return "Reply in the same language the lead writes in. If they haven't written yet, use English.";
}

const renderBlock = (b: { heading: string; body: string }) =>
  b.heading ? `${b.heading}\n${b.body}` : b.body;

/**
 * The prompt actually sent to the model.
 *
 * Order matters and is fixed: identity, knowledge, voice, lead, established
 * facts, this turn's task, opening rules, general rules, limits, never-say,
 * schema instruction. The editable sections are interleaved rather than
 * appended so an instruction can't end up below the thing it's meant to govern
 * — which is exactly the bug that made the old hardcoded disclosure line
 * override a character's persona.
 */
export function renderSystemPrompt(args: Parameters<typeof buildPromptParts>[0]): string {
  const { editable, automatic } = buildPromptParts(args);
  const byHeading = new Map(editable.map((b) => [b.heading, b]));
  const auto = new Map(automatic.map((b) => [b.heading, b]));

  const order: ({ heading: string; body: string } | undefined)[] = [
    byHeading.get(""), // identity
    auto.get("VOICE"),
    byHeading.get("WHAT YOU KNOW"),
    auto.get("YOUR PLAYBOOK"),
    auto.get("THE LEAD"),
    auto.get("ESTABLISHED IN THIS CONVERSATION"),
    auto.get("YOUR TASK THIS TURN"),
    auto.get("LANGUAGE"),
    byHeading.get("THIS IS THE FIRST MESSAGE"),
    byHeading.get("RULES"),
    auto.get("LIMITS"),
    byHeading.get("NEVER SAY"),
    auto.get(""), // schema instruction
  ];

  return order
    .filter((b): b is { heading: string; body: string } => Boolean(b))
    .map(renderBlock)
    .join("\n\n");
}
