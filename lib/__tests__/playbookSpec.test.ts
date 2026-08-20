import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAYBOOK,
  upgradeSpec,
  validatePlaybook,
  type PlaybookSpec,
} from "../playbookSpec";

describe("the shipped default playbook", () => {
  it("is valid against its own criteria", () => {
    const known = new Set(DEFAULT_PLAYBOOK.criteriaKeys);
    expect(validatePlaybook(DEFAULT_PLAYBOOK, known)).toEqual([]);
  });

  it("round-trips through upgradeSpec unchanged", () => {
    expect(upgradeSpec(DEFAULT_PLAYBOOK)).toEqual(DEFAULT_PLAYBOOK);
  });
});

describe("validatePlaybook", () => {
  const base = (): PlaybookSpec => structuredClone(DEFAULT_PLAYBOOK);

  it("requires a name and instructions", () => {
    const errs = validatePlaybook({ ...base(), name: "", instructions: "" });
    expect(errs.join(" ")).toMatch(/name/);
    expect(errs.join(" ")).toMatch(/instructions/);
  });

  it("rejects a message cap outside 1..100", () => {
    expect(validatePlaybook({ ...base(), maxAiMessages: 0 }).join(" ")).toMatch(/message cap/i);
  });

  it("rejects a follow-up gap under a day when there are follow-ups", () => {
    const errs = validatePlaybook({ ...base(), followUp: { count: 2, everyDays: 0 } });
    expect(errs.join(" ")).toMatch(/between follow-ups/i);
  });

  it("flags a criterion key that no longer exists", () => {
    const errs = validatePlaybook({ ...base(), criteriaKeys: ["ghost"] }, new Set(["use_case"]));
    expect(errs.join(" ")).toMatch(/"ghost".*not a qualification criterion/);
  });

  it("skips the criterion check when no known set is supplied", () => {
    expect(validatePlaybook({ ...base(), criteriaKeys: ["ghost"] })).toEqual([]);
  });
});

describe("upgradeSpec from older shapes", () => {
  it("turns a v1 flat playbook into valid v3 prose", () => {
    const v1 = {
      name: "Old flat",
      maxTurns: 8,
      objectives: [
        { key: "use_case", question: "What are you using proxies for?" },
        { key: "monthly_volume", question: "How much traffic per month?" },
      ],
      disqualifyWhen: [],
    };
    const v3 = upgradeSpec(v1);
    expect(v3.version).toBe(3);
    expect(v3.criteriaKeys).toEqual(["use_case", "monthly_volume"]);
    expect(v3.instructions).toContain("What are you using proxies for?");
    expect(validatePlaybook(v3, new Set(v3.criteriaKeys))).toEqual([]);
  });

  it("turns a v2 workflow graph into valid v3 prose, carrying the chase cadence", () => {
    const v2 = {
      name: "Old graph",
      version: 2,
      startStepId: "open",
      steps: [
        { id: "open", type: "outreach", label: "Open", channel: "preferred" },
        {
          id: "followup1",
          type: "outreach",
          label: "Follow up",
          channel: "preferred",
          brief: "nudge",
          delayMinutes: 4320, // 3 days
        },
        {
          id: "qualify",
          type: "qualify",
          maxTurns: 8,
          objectives: [{ key: "use_case", question: "What for?" }],
          disqualifyWhen: [],
        },
      ],
    };
    const v3 = upgradeSpec(v2);
    expect(v3.version).toBe(3);
    expect(v3.criteriaKeys).toEqual(["use_case"]);
    expect(v3.followUp.everyDays).toBe(3);
    expect(v3.instructions).toContain("What for?");
    expect(validatePlaybook(v3, new Set(v3.criteriaKeys))).toEqual([]);
  });

  it("falls back to the default for an empty or unrecognisable spec", () => {
    expect(upgradeSpec({}).instructions).toBe(DEFAULT_PLAYBOOK.instructions);
    expect(upgradeSpec(null).instructions).toBe(DEFAULT_PLAYBOOK.instructions);
  });

  it("normalises a v3 spec missing optional fields", () => {
    const partial = { name: "Sparse", version: 3, instructions: "Do the thing." };
    const v3 = upgradeSpec(partial);
    expect(v3.criteriaKeys).toEqual([]);
    expect(v3.maxAiMessages).toBeGreaterThan(0);
    expect(v3.followUp.count).toBeGreaterThanOrEqual(0);
    expect(v3.defaultLanguage).toBe("");
  });
});
