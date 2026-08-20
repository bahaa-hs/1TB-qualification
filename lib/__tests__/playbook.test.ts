import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHARACTER,
  groundExtracted,
  turnResponseSchema,
  validateTurnResponse,
  type ExtractionField,
} from "../playbook";
import { DEFAULT_CRITERIA, extractionFields } from "../criteria";

const fields: ExtractionField[] = extractionFields(DEFAULT_CRITERIA);
const ok = { extracted: {}, reply: "Hi there, what are you building?", leadIntent: "answering", handoff: false };

describe("turnResponseSchema", () => {
  it("requires the four top-level keys and lists every criterion in extracted", () => {
    const schema = turnResponseSchema(fields) as {
      required: string[];
      properties: { extracted: { required: string[]; properties: Record<string, { enum?: unknown[] }> } };
    };
    expect(schema.required).toEqual(["extracted", "reply", "leadIntent", "handoff"]);
    expect(schema.properties.extracted.required).toEqual(fields.map((f) => f.key));
    // A choice criterion carries its tokens plus null; free text has no enum.
    expect(schema.properties.extracted.properties.use_case.enum).toContain("web_scraping");
    expect(schema.properties.extracted.properties.use_case.enum).toContain(null);
    expect(schema.properties.extracted.properties.monthly_volume.enum).toBeUndefined();
  });
});

describe("validateTurnResponse", () => {
  it("accepts a well-formed response and coerces a missing handoff to false", () => {
    const { extracted: _e, ...noHandoff } = { ...ok };
    void _e;
    const r = validateTurnResponse(fields, DEFAULT_CHARACTER, { ...noHandoff, extracted: {} });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.handoff).toBe(false);
  });

  it("passes a true handoff through", () => {
    const r = validateTurnResponse(fields, DEFAULT_CHARACTER, { ...ok, handoff: true });
    expect(r.ok && r.value.handoff).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(validateTurnResponse(fields, DEFAULT_CHARACTER, "nope").ok).toBe(false);
  });

  it("rejects an empty reply", () => {
    const r = validateTurnResponse(fields, DEFAULT_CHARACTER, { ...ok, reply: "  " });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.join(" ")).toMatch(/empty reply/);
  });

  it("rejects a reply over the character's word limit", () => {
    const r = validateTurnResponse(fields, DEFAULT_CHARACTER, { ...ok, reply: "word ".repeat(300) });
    expect(!r.ok && r.errors.join(" ")).toMatch(/90-word limit/);
  });

  it("rejects an unfilled placeholder", () => {
    const r = validateTurnResponse(fields, DEFAULT_CHARACTER, { ...ok, reply: "Hi {{first_name}}" });
    expect(!r.ok && r.errors.join(" ")).toMatch(/placeholder/);
  });

  it("rejects a never-say phrase, case-insensitively", () => {
    const r = validateTurnResponse(fields, DEFAULT_CHARACTER, { ...ok, reply: "We are the CHEAPEST around" }, [
      "cheapest",
    ]);
    expect(!r.ok && r.errors.join(" ")).toMatch(/never-say/);
  });

  it("rejects emoji when the character forbids them", () => {
    const r = validateTurnResponse(fields, DEFAULT_CHARACTER, { ...ok, reply: "Sounds great 🚀" });
    expect(!r.ok && r.errors.join(" ")).toMatch(/emoji/);
  });

  it("rejects an out-of-range leadIntent", () => {
    const r = validateTurnResponse(fields, DEFAULT_CHARACTER, { ...ok, leadIntent: "curious" });
    expect(!r.ok && r.errors.join(" ")).toMatch(/leadIntent/);
  });

  it("rejects a hallucinated extracted key", () => {
    const r = validateTurnResponse(fields, DEFAULT_CHARACTER, {
      ...ok,
      extracted: { made_up: "value" },
    });
    expect(!r.ok && r.errors.join(" ")).toMatch(/not a tracked criterion/);
  });

  it("rejects an out-of-range enum answer", () => {
    const r = validateTurnResponse(fields, DEFAULT_CHARACTER, {
      ...ok,
      extracted: { use_case: "banana" },
    });
    expect(!r.ok && r.errors.join(" ")).toMatch(/not one of/);
  });

  it("keeps a valid extracted value", () => {
    const r = validateTurnResponse(fields, DEFAULT_CHARACTER, {
      ...ok,
      extracted: { use_case: "web_scraping" },
    });
    expect(r.ok && r.value.extracted.use_case).toBe("web_scraping");
  });
});

describe("groundExtracted", () => {
  it("drops a free-text fact the lead's message doesn't support", () => {
    const { kept, dropped } = groundExtracted(fields, { monthly_volume: "1TB+" }, "we scrape ecommerce sites");
    expect(kept.monthly_volume).toBeUndefined();
    expect(dropped).toEqual(['monthly_volume="1TB+"']);
  });

  it("keeps a free-text fact the lead did say", () => {
    const { kept } = groundExtracted(
      fields,
      { target_sites: "amazon and ebay" },
      "mostly amazon and ebay listings",
    );
    expect(kept.target_sites).toBe("amazon and ebay");
  });

  it("never grounds an enum answer against the wording", () => {
    const { kept } = groundExtracted(fields, { use_case: "web_scraping" }, "we do web scraping");
    expect(kept.use_case).toBe("web_scraping");
  });
});
