import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetDbForTests } from "../db";
import { parseFilloutCsv } from "../csv";
import {
  activeThreadLead,
  appendMessage,
  claimStage,
  getLead,
  importLeads,
  listLeads,
  listMessages,
  pendingDraft,
  setAiEnabled,
} from "../leads";
import {
  advanceConversation,
  confirmSent,
  manualThreadId,
  recordManualReply,
} from "../conversation";

// The AI-driven paths need a configured provider and a network call. runTurn
// itself is covered directly in qualify.test.ts; here we exercise the
// database-side lifecycle the relay depends on.
//
// Partial mock, not a replacement: lib/connections.ts imports PROVIDERS and
// currentProviderConfig from this module, and stubbing the whole thing breaks
// them in a way that looks like a test failure rather than a mock problem.
vi.mock("../llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../llm")>()),
  llm: () => {
    throw new Error("no provider in tests");
  },
  llmFor: () => {
    throw new Error("no provider in tests");
  },
}));

const HEADER =
  "Submission ID,Last updated,Submission started,Status,Current step,First name,Last name,Company website,Email address,LinkedIn profile link,How can we contact you?,Phone number,Whatsapp,Telegram,Skype,Expected monthly traffic volume,I meet the following criteria for approval:,email,Errors,Url,Network ID";
const MARK =
  "b587709a,x,x,finished,Ending,Mark,Wilson,techproxy.com,mark@techproxy.com,https://linkedin.com/in/mark,LinkedIn Messenger,,,,,1TB+,TRUE,,None,https://u,n1";

function seedLead() {
  const parsed = parseFilloutCsv([HEADER, MARK].join("\n"));
  importLeads("test.csv", parsed.leads, parsed.skipped);
  return listLeads()[0];
}

/** Stand in for what the engine writes when the model replies. */
function fakeDraft(leadId: number, body: string) {
  return appendMessage({
    leadId,
    channel: "linkedin",
    direction: "outbound",
    body,
    sentBy: "ai",
    sent: false,
  })!;
}

beforeEach(() => {
  _resetDbForTests(":memory:");
});

describe("confirmSent", () => {
  it("moves a fresh lead to outreached and schedules a chase", () => {
    const lead = seedLead();
    const draft = fakeDraft(lead.id, "Hi Mark, what are you using proxies for?");
    expect(getLead(lead.id)!.stage).toBe("fresh");

    expect(confirmSent(draft.id, lead.id)).toBe(true);

    const after = getLead(lead.id)!;
    expect(after.stage).toBe("outreached");
    // first_outreach_at is what the give-up window measures from.
    expect(after.first_outreach_at).not.toBeNull();
    // A lead awaiting a reply has the follow-up clock running.
    expect(after.next_due_at).not.toBeNull();
    expect(pendingDraft(lead.id)).toBeNull();
  });

  it("registers the conversation on the allowlist", () => {
    const lead = seedLead();
    confirmSent(fakeDraft(lead.id, "opener").id, lead.id);
    expect(activeThreadLead("linkedin", manualThreadId(lead.id))!.id).toBe(lead.id);
  });

  it("revokes that access when the lead reaches a terminal stage", () => {
    const lead = seedLead();
    confirmSent(fakeDraft(lead.id, "opener").id, lead.id);
    claimStage(lead.id, ["outreached"], "handed_off");
    expect(activeThreadLead("linkedin", manualThreadId(lead.id))).toBeNull();
  });

  it("is idempotent — a double click doesn't restart anything", () => {
    const lead = seedLead();
    const draft = fakeDraft(lead.id, "opener");
    expect(confirmSent(draft.id, lead.id)).toBe(true);
    const firstAt = getLead(lead.id)!.first_outreach_at;

    expect(confirmSent(draft.id, lead.id)).toBe(false);
    expect(getLead(lead.id)!.first_outreach_at).toBe(firstAt);
  });

  it("does not re-stage a lead that is already past outreached", () => {
    const lead = seedLead();
    confirmSent(fakeDraft(lead.id, "opener").id, lead.id);
    claimStage(lead.id, ["outreached"], "replied");

    confirmSent(fakeDraft(lead.id, "follow-up").id, lead.id);
    const after = getLead(lead.id)!;
    expect(after.stage).toBe("replied");
    // Mid-conversation the lead, not the clock, drives things.
    expect(after.next_due_at).toBeNull();
  });
});

describe("recordManualReply", () => {
  it("moves the lead to replied and saves the reply", async () => {
    // Without a provider the AI turn blocks, but the reply and the stage move
    // are the database-side behaviour we care about here.
    const lead = seedLead();
    confirmSent(fakeDraft(lead.id, "opener").id, lead.id);

    await recordManualReply(lead.id, "we scrape ecommerce sites");

    const after = getLead(lead.id)!;
    expect(after.stage).toBe("replied");
    expect(after.next_due_at).toBeNull();
    expect(listMessages(lead.id).some((m) => m.direction === "inbound")).toBe(true);
  });

  it("saves the reply but runs no AI turn once a human has taken over", async () => {
    const lead = seedLead();
    confirmSent(fakeDraft(lead.id, "opener").id, lead.id);
    setAiEnabled(lead.id, false);

    const result = await recordManualReply(lead.id, "we scrape ecommerce sites");

    expect(result.kind).toBe("skipped");
    expect(result.kind === "skipped" && result.reason).toMatch(/AI is off/i);
    expect(listMessages(lead.id).some((m) => m.direction === "inbound")).toBe(true);
    expect(getLead(lead.id)!.stage).toBe("replied");
  });

  it("refuses to log a reply while a draft is still unsent", async () => {
    const lead = seedLead();
    confirmSent(fakeDraft(lead.id, "opener").id, lead.id);
    fakeDraft(lead.id, "unsent follow-up");

    const result = await recordManualReply(lead.id, "sure, ecommerce");
    expect(result.kind).toBe("skipped");
    expect(result.kind === "skipped" && result.reason).toMatch(/discard/i);
    expect(listMessages(lead.id).some((m) => m.direction === "inbound")).toBe(false);
  });

  it("ignores an empty paste", async () => {
    const lead = seedLead();
    confirmSent(fakeDraft(lead.id, "opener").id, lead.id);

    expect((await recordManualReply(lead.id, "   ")).kind).toBe("skipped");
    expect(listMessages(lead.id)).toHaveLength(1);
  });

  it("refuses once the lead is finished", async () => {
    const lead = seedLead();
    confirmSent(fakeDraft(lead.id, "opener").id, lead.id);
    claimStage(lead.id, ["outreached"], "rejected");

    const result = await recordManualReply(lead.id, "actually wait");
    expect(result.kind).toBe("skipped");
    expect(listMessages(lead.id).some((m) => m.direction === "inbound")).toBe(false);
  });
});

describe("advanceConversation guards", () => {
  it("refuses when a human has taken over", async () => {
    const lead = seedLead();
    setAiEnabled(lead.id, false);

    const r = await advanceConversation(lead.id);
    expect(r.kind).toBe("skipped");
    expect(r.kind === "skipped" && r.reason).toMatch(/human has taken over/i);
  });

  it("refuses when the lead is finished", async () => {
    const lead = seedLead();
    claimStage(lead.id, ["fresh"], "rejected");
    expect((await advanceConversation(lead.id)).kind).toBe("skipped");
  });

  it("refuses while a draft is still waiting to be sent", async () => {
    const lead = seedLead();
    fakeDraft(lead.id, "waiting");

    const r = await advanceConversation(lead.id);
    expect(r.kind).toBe("skipped");
    expect(r.kind === "skipped" && r.reason).toMatch(/already a message waiting/i);
  });

  it("surfaces a provider failure as blocked rather than throwing", async () => {
    const lead = seedLead();

    const r = await advanceConversation(lead.id);
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.errors.join(" ")).toMatch(/no provider/i);
    expect(getLead(lead.id)!.last_error).toMatch(/no provider/i);
  });
});
