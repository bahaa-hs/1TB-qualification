import { describe, expect, it } from "vitest";
import {
  CRITERION_KEY_RE,
  DEFAULT_CRITERIA,
  blankCriterion,
  criterionLabel,
  criterionValues,
  establishedFacts,
  findCriterion,
  nearestKey,
  placeholderTokens,
  unknownPlaceholders,
  validateCriterion,
  validateRegistry,
  valueLabel,
  valueTokens,
  type Criterion,
} from "../criteria";

const choice = (over: Partial<Criterion> = {}): Criterion => ({
  key: "use_case",
  label: "Use case",
  kind: "choice",
  description: "What they need proxies for",
  showOnBoard: true,
  values: [
    { value: "web_scraping", label: "Web scraping", definition: "Crawling sites at scale" },
    { value: "other", label: "Something else" },
  ],
  ...over,
});

describe("the shipped glossary", () => {
  it("validates", () => {
    expect(validateRegistry(DEFAULT_CRITERIA)).toEqual([]);
  });

  it("covers every key the shipped playbook asks about", () => {
    // If these drift apart, an existing install seeds a criterion from a
    // question instead of a written definition, and the AI loses the glossary.
    for (const key of ["use_case", "target_sites", "monthly_volume", "timeline", "current_provider"]) {
      expect(findCriterion(DEFAULT_CRITERIA, key)).not.toBeNull();
    }
  });

  it("defines every use_case value, because that is the point of the feature", () => {
    const useCase = findCriterion(DEFAULT_CRITERIA, "use_case")!;
    for (const v of useCase.values!) expect(v.definition?.length).toBeGreaterThan(10);
  });
});

describe("keys", () => {
  it.each(["use_case", "a", "x1", "a_b_c9"])("accepts %s", (k) => {
    expect(CRITERION_KEY_RE.test(k)).toBe(true);
  });

  it.each(["Use_case", "1st", "use-case", "use case", "", "use.case"])("rejects %s", (k) => {
    expect(CRITERION_KEY_RE.test(k)).toBe(false);
  });

  it("forbids a dot, which is what keeps {{use_case}} from colliding with {{lead.x}}", () => {
    // Every built-in token contains a dot and no criterion key may, so the two
    // halves of the placeholder namespace are disjoint by construction. If this
    // ever fails, lib/prompt.ts needs rethinking before the regex is widened.
    expect(CRITERION_KEY_RE.test("lead.firstName")).toBe(false);
    expect(CRITERION_KEY_RE.test("character.name")).toBe(false);
  });

  it("rejects a reserved word that would shadow a built-in namespace", () => {
    expect(validateCriterion(choice({ key: "lead" }), []).join(" ")).toMatch(/reserved/);
  });

  it("rejects a duplicate", () => {
    const a = choice();
    const b = choice({ label: "Second" });
    expect(validateCriterion(a, [a, b]).join(" ")).toMatch(/share the key/);
  });
});

describe("validateCriterion", () => {
  it("passes a well-formed choice", () => {
    expect(validateCriterion(choice(), [])).toEqual([]);
  });

  it("passes a well-formed free-text criterion", () => {
    expect(
      validateCriterion(
        { key: "target_sites", label: "Target sites", kind: "text", description: "", showOnBoard: false },
        [],
      ),
    ).toEqual([]);
  });

  it("requires at least one answer on a choice", () => {
    expect(validateCriterion(choice({ values: [] }), []).join(" ")).toMatch(/at least one answer/);
  });

  it("requires a name", () => {
    expect(validateCriterion(choice({ label: "  " }), []).join(" ")).toMatch(/give it a name/);
  });

  it("holds answers to the same shape as keys, so they're safe in an enum", () => {
    const bad = choice({ values: [{ value: "Web Scraping", label: "Web scraping" }] });
    expect(validateCriterion(bad, []).join(" ")).toMatch(/lowercase letters/);
  });

  it("rejects a duplicated answer", () => {
    const bad = choice({
      values: [
        { value: "a_b", label: "One" },
        { value: "a_b", label: "Two" },
      ],
    });
    expect(validateCriterion(bad, []).join(" ")).toMatch(/more than once/);
  });

  it("reports every problem at once rather than the first", () => {
    const bad = choice({ key: "Bad Key", label: "", values: [] });
    expect(validateCriterion(bad, []).length).toBeGreaterThan(2);
  });
});

describe("labels", () => {
  it("renders a stored token the way a person wrote it", () => {
    expect(valueLabel(choice(), "web_scraping")).toBe("Web scraping");
  });

  it("falls back to the raw value for something not in the list", () => {
    // A value collected before an answer was renamed is still evidence.
    expect(valueLabel(choice(), "seo_monitoring")).toBe("seo_monitoring");
  });

  it("falls back to the raw key for a criterion that no longer exists", () => {
    expect(criterionLabel([choice()], "budget")).toBe("budget");
  });

  it("lists the canonical tokens, which is what conditions compare", () => {
    expect(valueTokens(choice())).toEqual(["web_scraping", "other"]);
  });
});

describe("establishedFacts", () => {
  const registry = [choice(), { key: "notes", label: "Notes", kind: "text" as const, description: "", showOnBoard: false }];

  it("renders values by label and keeps registry order", () => {
    const facts = establishedFacts(registry, { notes: "call monday", use_case: "web_scraping" });
    expect(facts.map((f) => f.key)).toEqual(["use_case", "notes"]);
    expect(facts[0].display).toBe("Web scraping");
    expect(facts[0].showOnBoard).toBe(true);
  });

  it("skips blanks and non-strings rather than rendering empty rows", () => {
    expect(establishedFacts(registry, { use_case: "  ", notes: null, other: 3 })).toEqual([]);
  });

  it("keeps a value whose criterion is gone, flagged as unknown", () => {
    // It's the evidence a verdict was based on — dropping it silently rewrites
    // the audit trail.
    const facts = establishedFacts(registry, { budget: "5k" });
    expect(facts).toHaveLength(1);
    expect(facts[0].known).toBe(false);
    expect(facts[0].label).toBe("budget");
  });
});

describe("criterionValues", () => {
  it("gives the label, not the token, so a message reads naturally", () => {
    expect(criterionValues([choice()], { use_case: "web_scraping" })).toEqual({
      use_case: "Web scraping",
    });
  });

  it("omits a criterion this lead has no value for", () => {
    // Load-bearing: an absent key leaves the token in place so the line
    // mentioning it can be dropped, rather than rendering "they said .".
    expect(criterionValues([choice()], {})).toEqual({});
    expect(criterionValues([choice()], { use_case: "   " })).toEqual({});
  });
});

describe("placeholders", () => {
  it("finds every distinct token", () => {
    expect(placeholderTokens("Hi {{lead.firstName}}, you said {{use_case}} — {{use_case}}?")).toEqual([
      "lead.firstName",
      "use_case",
    ]);
  });

  it("tolerates whitespace inside the braces", () => {
    expect(placeholderTokens("{{ use_case }}")).toEqual(["use_case"]);
  });

  it("ignores something that isn't a token", () => {
    expect(placeholderTokens("{{}} and {{1st}} and { use_case }")).toEqual([]);
  });

  it("names the tokens that are neither built-in nor a criterion", () => {
    const known = new Set(["lead.firstName", "use_case"]);
    expect(unknownPlaceholders("{{lead.firstName}} {{use_cse}} {{use_case}}", known)).toEqual([
      "use_cse",
    ]);
  });

  it("suggests the key a typo was probably reaching for", () => {
    expect(nearestKey("use_cse", ["use_case", "timeline"])).toBe("use_case");
  });

  it("suggests nothing for a genuinely different word", () => {
    // A misleading suggestion is worse than none.
    expect(nearestKey("budget", ["use_case", "timeline"])).toBeNull();
  });
});

describe("blankCriterion", () => {
  it("never collides with a key already in use", () => {
    let registry: Criterion[] = [];
    for (let i = 0; i < 4; i++) {
      const c = blankCriterion(registry);
      expect(registry.some((x) => x.key === c.key)).toBe(false);
      registry = [...registry, c];
    }
  });

  it("starts as a choice with one empty answer, ready to type into", () => {
    const c = blankCriterion([]);
    expect(c.kind).toBe("choice");
    expect(c.values).toHaveLength(1);
  });
});
