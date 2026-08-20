/**
 * Qualification criteria — the glossary the AI is taught from.
 *
 * A criterion is one named fact we want to know about a lead: `use_case`,
 * `monthly_volume`, `target_sites`. It is defined once, globally, and every
 * character and every workflow shares it. That is the point — the pipeline
 * board, the workflow and the model all end up talking about the same names.
 *
 * The half that matters most is `values[].definition`. Told to choose between
 * `seo_monitoring` and `market_research` with no gloss, a small model
 * coin-flips; told what each one means, it doesn't. So a criterion is not just
 * a list of allowed answers, it's a dictionary entry.
 *
 * Everything here is pure and safe to import from a client component. Storage
 * lives in lib/criteriaStore.ts, which touches the database and must not be
 * pulled into the browser bundle.
 */

/**
 * The rule objective keys have always used, now defined in one place.
 *
 * Load-bearing beyond validation: it forbids a dot, and every built-in
 * placeholder token contains one (`{{lead.firstName}}`). That is what makes
 * `{{use_case}}` safe as a bare token — the two namespaces cannot collide, by
 * construction. Don't widen this without reading lib/prompt.ts first.
 */
export const CRITERION_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** Bare words a criterion may not take, so a built-in token can't be shadowed. */
const RESERVED_KEYS = new Set(["character", "lead", "vars", "var"]);

export type CriterionKind = "choice" | "text";

export interface CriterionValue {
  /** The canonical token. Stored in `collected`, compared in conditions. */
  value: string;
  /** What a person sees. "Web scraping". Never sent as the value. */
  label: string;
  /** The glossary entry — what the model reads to decide when this applies. */
  definition?: string;
}

export interface Criterion {
  key: string;
  label: string;
  kind: CriterionKind;
  /** Required and non-empty when kind is "choice". Absent for free text. */
  values?: CriterionValue[];
  /** What this criterion means. Becomes the JSON Schema description. */
  description: string;
  /** Show it as a badge on the pipeline board's lead cards. */
  showOnBoard: boolean;
}

export type CriteriaRegistry = Criterion[];

// ─── Lookups ─────────────────────────────────────────────────────────────────

export function findCriterion(registry: CriteriaRegistry, key: string): Criterion | null {
  return registry.find((c) => c.key === key) ?? null;
}

/** The canonical tokens, which is what the schema enum and conditions use. */
export function valueTokens(c: Criterion): string[] {
  return c.values?.map((v) => v.value) ?? [];
}

/** A stored token rendered for a human: `web_scraping` → "Web scraping". */
export function valueLabel(c: Criterion | null, value: string): string {
  const match = c?.values?.find((v) => v.value === value);
  return match?.label?.trim() || value;
}

/** A collected key rendered for a human, falling back to the raw key. */
export function criterionLabel(registry: CriteriaRegistry, key: string): string {
  return findCriterion(registry, key)?.label?.trim() || key;
}

/**
 * The criteria a playbook targets, in registry order.
 *
 * `keys` empty means "every criterion". Unknown keys are skipped rather than
 * erroring — a playbook validated against the registry can't contain them, and
 * being lenient here keeps a stale reference from breaking a live conversation.
 */
export function targetedCriteria(registry: CriteriaRegistry, keys: string[]): Criterion[] {
  if (!keys.length) return registry;
  const want = new Set(keys);
  return registry.filter((c) => want.has(c.key));
}

/**
 * Flatten criteria to the minimal shape the turn schema, validator and
 * grounding use (lib/playbook.ts ExtractionField). A "choice" criterion
 * contributes its canonical tokens as fixed options; free text has none.
 */
export function extractionFields(
  criteria: CriteriaRegistry,
): { key: string; options?: string[]; description?: string }[] {
  return criteria.map((c) => ({
    key: c.key,
    options: c.kind === "choice" ? valueTokens(c) : undefined,
    description: c.description?.trim() || c.label,
  }));
}

/**
 * What's been established about a lead, ready to display.
 *
 * Keys with no criterion are kept rather than dropped — a value collected
 * before someone renamed or removed a criterion is still the evidence a verdict
 * was based on, so the caller decides how to present it, not us.
 */
export interface EstablishedFact {
  key: string;
  label: string;
  value: string;
  display: string;
  known: boolean;
  showOnBoard: boolean;
}

export function establishedFacts(
  registry: CriteriaRegistry,
  collected: Record<string, unknown>,
): EstablishedFact[] {
  const out: EstablishedFact[] = [];
  for (const [key, raw] of Object.entries(collected)) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const value = raw.trim();
    const c = findCriterion(registry, key);
    out.push({
      key,
      label: c?.label?.trim() || key,
      value,
      display: valueLabel(c, value),
      known: Boolean(c),
      showOnBoard: c?.showOnBoard ?? false,
    });
  }
  // Registry order, so the board reads the same way every time; unknown keys
  // last, since they're the leftovers.
  const rank = new Map(registry.map((c, i) => [c.key, i]));
  return out.sort(
    (a, b) => (rank.get(a.key) ?? Infinity) - (rank.get(b.key) ?? Infinity) || a.key.localeCompare(b.key),
  );
}

// ─── Validation ──────────────────────────────────────────────────────────────

export function validateCriterion(c: Criterion, others: CriteriaRegistry): string[] {
  const errors: string[] = [];
  const at = c.label?.trim() || c.key || "This criterion";

  if (!CRITERION_KEY_RE.test(c.key ?? "")) {
    errors.push(`${at}: the key must be lowercase letters, numbers and underscores, starting with a letter.`);
  } else if (RESERVED_KEYS.has(c.key)) {
    errors.push(`${at}: "${c.key}" is reserved — pick another key.`);
  } else if (others.some((o) => o !== c && o.key === c.key)) {
    errors.push(`Two criteria share the key "${c.key}".`);
  }

  if (!c.label?.trim()) errors.push(`${c.key || "A criterion"}: give it a name.`);

  if (c.kind === "choice") {
    if (!c.values?.length) {
      errors.push(`${at}: a criterion with fixed answers needs at least one answer.`);
    } else {
      const seen = new Set<string>();
      for (const v of c.values) {
        if (!CRITERION_KEY_RE.test(v.value ?? "")) {
          errors.push(
            `${at}: the answer "${v.value}" must be lowercase letters, numbers and underscores.`,
          );
        } else if (seen.has(v.value)) {
          errors.push(`${at}: the answer "${v.value}" is listed more than once.`);
        } else {
          seen.add(v.value);
        }
        if (!v.label?.trim()) errors.push(`${at}: the answer "${v.value}" needs a name.`);
      }
    }
  }

  return errors;
}

export function validateRegistry(registry: CriteriaRegistry): string[] {
  return registry.flatMap((c) => validateCriterion(c, registry));
}

// ─── Placeholders ────────────────────────────────────────────────────────────

/**
 * Values for this lead, for {{token}} substitution.
 *
 * Only criteria that actually have a value are included. A declared-but-unknown
 * one is deliberately absent so its token survives substitution and the line
 * that mentions it can be dropped — see buildPromptParts. Resolving it to an
 * empty string instead would produce "they said ." and a small model will
 * invent a filler to repair the sentence.
 */
export function criterionValues(
  registry: CriteriaRegistry,
  collected: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of registry) {
    const raw = collected[c.key];
    if (typeof raw !== "string" || !raw.trim()) continue;
    out[c.key] = valueLabel(c, raw.trim());
  }
  return out;
}

/** Every `{{token}}` in `text`, deduplicated, in the order they appear. */
export function placeholderTokens(text: string): string[] {
  const found = text.match(/\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g) ?? [];
  return [...new Set(found.map((t) => t.replace(/[{}\s]/g, "")))];
}

/**
 * Tokens that are neither a built-in nor a criterion key.
 *
 * An unknown token is an authoring mistake, and it is caught at save time
 * rather than at runtime: left in the text it reaches the system prompt
 * verbatim, the model copies it into its reply, and the placeholder guardrail
 * blocks the lead twice with an error naming neither the typo nor the field it
 * was in.
 */
export function unknownPlaceholders(text: string, known: Set<string>): string[] {
  return placeholderTokens(text).filter((t) => !known.has(t));
}

/** Closest key by edit distance, for "did you mean…". Null when nothing is near. */
export function nearestKey(token: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const d = editDistance(token, c);
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }
  // A third of the token's length, so "use_cse" finds "use_case" but a genuinely
  // different word doesn't get a misleading suggestion.
  return best && bestScore <= Math.max(1, Math.floor(token.length / 3)) ? best : null;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

// ─── The shipped glossary ────────────────────────────────────────────────────

/**
 * Seeded on first run, and the fallback when the registry is empty.
 *
 * These are the keys the shipped playbook already uses, so an existing install
 * lands with its own definitions rather than a blank page.
 */
export const DEFAULT_CRITERIA: CriteriaRegistry = [
  {
    key: "use_case",
    label: "Use case",
    kind: "choice",
    description: "What the lead plans to use proxies for. The main thing qualification turns on.",
    showOnBoard: true,
    values: [
      {
        value: "web_scraping",
        label: "Web scraping",
        definition: "Crawling or harvesting data from websites at scale — prices, listings, search results.",
      },
      {
        value: "ad_verification",
        label: "Ad verification",
        definition: "Checking how their ads render in different countries, or spotting ad fraud.",
      },
      {
        value: "seo_monitoring",
        label: "SEO monitoring",
        definition: "Tracking search rankings or SERP results by location.",
      },
      {
        value: "social_media",
        label: "Social media",
        definition: "Running or automating accounts on social platforms.",
      },
      {
        value: "market_research",
        label: "Market research",
        definition: "Gathering competitor or market data, without the scale of a scraping operation.",
      },
      {
        value: "other",
        label: "Something else",
        definition: "Anything that doesn't fit the categories above.",
      },
    ],
  },
  {
    key: "target_sites",
    label: "Target sites",
    kind: "text",
    description: "Which websites or platforms they're pointing the proxies at, in their own words.",
    showOnBoard: false,
  },
  {
    key: "monthly_volume",
    label: "Monthly volume",
    kind: "text",
    description: "Roughly how much traffic they expect per month, in their own words.",
    showOnBoard: true,
  },
  {
    key: "timeline",
    label: "Timeline",
    kind: "text",
    description: "When they want to start.",
    showOnBoard: false,
  },
  {
    key: "current_provider",
    label: "Current provider",
    kind: "text",
    description: "Who they buy proxies from today, if anyone.",
    showOnBoard: false,
  },
];

/** A new blank criterion, ready to edit. */
export function blankCriterion(registry: CriteriaRegistry): Criterion {
  const taken = new Set(registry.map((c) => c.key));
  let n = registry.length + 1;
  while (taken.has(`criterion_${n}`)) n++;
  return {
    key: `criterion_${n}`,
    label: "",
    kind: "choice",
    description: "",
    showOnBoard: false,
    values: [{ value: "", label: "" }],
  };
}
