import { beforeEach, describe, expect, it } from "vitest";
import { _resetDbForTests, db } from "../db";
import { parseFilloutCsv } from "../csv";
import {
  activeThreadLead,
  addThread,
  appendMessage,
  assertActiveThread,
  claimStage,
  disableAllAi,
  discardDraft,
  getLead,
  getReview,
  importLeads,
  leadWarnings,
  listLeads,
  listMessages,
  markMessageSent,
  pendingDraft,
  recordReview,
  setAiEnabled,
  updateContact,
} from "../leads";

const HEADER =
  "Submission ID,Last updated,Submission started,Status,Current step,First name,Last name,Company website,Email address,LinkedIn profile link,How can we contact you?,Phone number,Whatsapp,Telegram,Skype,Expected monthly traffic volume,I meet the following criteria for approval:,email,Errors,Url,Network ID";

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join("\n");
}

const MARK =
  "b587709a,x,x,finished,Ending,Mark,Wilson,techproxy.com,mark@techproxy.com,https://linkedin.com/in/mark,LinkedIn Messenger,,,,,1TB+,TRUE,,None,https://u,n1";
const PRINCE =
  "066b89cc,x,x,finished,Ending,prince chohan,chohan,,princechohan4u@gmail.com,https://linkedin.com/in/prince,Whatsapp,,9.23188E+11,,,1TB+,TRUE,,None,https://u,n3";

function importSample(text: string) {
  const parsed = parseFilloutCsv(text);
  return importLeads("test.csv", parsed.leads, parsed.skipped);
}

beforeEach(() => {
  _resetDbForTests(":memory:");
});

describe("importLeads", () => {
  it("inserts leads and records import warnings", () => {
    const summary = importSample(csv(MARK, PRINCE));
    expect(summary.inserted).toBe(2);
    expect(summary.updated).toBe(0);
    expect(summary.withWarnings).toBe(1);

    const prince = listLeads().find((l) => l.submission_id === "066b89cc")!;
    expect(prince.whatsapp_e164).toBeNull();
    expect(prince.whatsapp_raw).toBe("9.23188E+11");
    expect(leadWarnings(prince)[0]).toMatch(/mangled/i);
  });

  it("is idempotent — re-uploading the same export creates no duplicates", () => {
    importSample(csv(MARK, PRINCE));
    const second = importSample(csv(MARK, PRINCE));
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(2);
    expect(listLeads()).toHaveLength(2);
  });

  it("starts every lead in the fresh stage with AI enabled", () => {
    importSample(csv(MARK));
    const lead = listLeads()[0];
    expect(lead.stage).toBe("fresh");
    expect(lead.ai_enabled).toBe(1);
  });
});

describe("updateContact", () => {
  it("fixes a mangled number and clears the warning", () => {
    importSample(csv(PRINCE));
    const id = listLeads()[0].id;

    const updated = updateContact(id, { whatsappE164: "+923187958826" }, "bahaa")!;
    expect(updated.whatsapp_e164).toBe("+923187958826");
    expect(leadWarnings(updated)).toEqual([]);
    expect(updated.contact_edited_by).toBe("bahaa");
  });

  it("survives a re-import of the original CSV", () => {
    // The whole point of stamping the edit: a later upload of the same broken
    // export must not silently undo a human correction.
    importSample(csv(PRINCE));
    const id = listLeads()[0].id;
    updateContact(id, { whatsappE164: "+923187958826" }, "bahaa");

    const second = importSample(csv(PRINCE));
    expect(getLead(id)!.whatsapp_e164).toBe("+923187958826");
    expect(leadWarnings(getLead(id)!)).toEqual([]);
    // ...and the import must not nag about a lead that's already been fixed.
    expect(second.withWarnings).toBe(0);
  });

  it("leaves unspecified fields untouched", () => {
    importSample(csv(MARK));
    const id = listLeads()[0].id;
    const updated = updateContact(id, { telegramHandle: "markw" }, "bahaa")!;
    expect(updated.telegram_handle).toBe("markw");
    expect(updated.email).toBe("mark@techproxy.com");
  });
});

describe("claimStage", () => {
  it("moves a lead and returns the updated row", () => {
    importSample(csv(MARK));
    const id = listLeads()[0].id;
    expect(claimStage(id, ["fresh"], "outreached")!.stage).toBe("outreached");
  });

  it("returns null when the lead is not in an allowed prior stage", () => {
    importSample(csv(MARK));
    const id = listLeads()[0].id;
    claimStage(id, ["fresh"], "outreached");

    // Second claim loses the race — this is the single-flight guard.
    expect(claimStage(id, ["fresh"], "outreached")).toBeNull();
  });

  it("refuses an AI-initiated move once a human has taken over", () => {
    importSample(csv(MARK));
    const id = listLeads()[0].id;
    claimStage(id, ["fresh"], "outreached");
    setAiEnabled(id, false);

    expect(
      claimStage(id, ["outreached"], "replied", { requireAiEnabled: true }),
    ).toBeNull();
    // A human-driven move is still allowed.
    expect(claimStage(id, ["outreached"], "replied")).not.toBeNull();
  });

  it("revokes every thread when a lead reaches a terminal stage", () => {
    importSample(csv(MARK));
    const id = listLeads()[0].id;
    addThread(id, "email", "thread-1");
    expect(activeThreadLead("email", "thread-1")).not.toBeNull();

    claimStage(id, ["fresh"], "rejected");

    // "All access removed once qualification is done, regardless of result."
    expect(activeThreadLead("email", "thread-1")).toBeNull();
  });
});

describe("the thread allowlist", () => {
  it("returns null for a conversation that was never allowlisted", () => {
    importSample(csv(MARK));
    expect(activeThreadLead("email", "some-strangers-thread")).toBeNull();
  });

  it("throws on an outbound attempt to a non-allowlisted thread", () => {
    expect(() => assertActiveThread("email", "nope")).toThrow(/not an active lead thread/i);
  });

  it("throws once a thread has been revoked", () => {
    importSample(csv(MARK));
    const id = listLeads()[0].id;
    addThread(id, "email", "thread-1");
    claimStage(id, ["fresh"], "handed_off");

    expect(() => assertActiveThread("email", "thread-1")).toThrow();
  });

  it("re-binding an external id to a lead un-revokes it", () => {
    importSample(csv(MARK, PRINCE));
    const [a, b] = listLeads();
    addThread(a.id, "telegram", "chat-9");
    addThread(b.id, "telegram", "chat-9");
    expect(activeThreadLead("telegram", "chat-9")!.id).toBe(b.id);
  });
});

describe("appendMessage", () => {
  it("stores a message and stamps last_inbound_at on inbound", () => {
    importSample(csv(MARK));
    const id = listLeads()[0].id;

    const stored = appendMessage({
      leadId: id, channel: "email", direction: "inbound",
      body: "we scrape ecommerce sites", externalMessageId: "<m1@x>", sentBy: "lead",
    });
    expect(stored).not.toBeNull();
    // Inbound messages are, by definition, already delivered.
    expect(stored!.sent_at).not.toBeNull();

    expect(listMessages(id)).toHaveLength(1);
    expect(getLead(id)!.last_inbound_at).not.toBeNull();
  });

  it("is idempotent on external message id", () => {
    // Polls overlap and re-fetch the same thread; a duplicate must not create a
    // second message or trigger a second AI turn.
    importSample(csv(MARK));
    const id = listLeads()[0].id;
    const msg = {
      leadId: id, channel: "email" as const, direction: "inbound" as const,
      body: "hi", externalMessageId: "<dupe@x>", sentBy: "lead" as const,
    };
    expect(appendMessage(msg)).not.toBeNull();
    expect(appendMessage(msg)).toBeNull();
    expect(listMessages(id)).toHaveLength(1);
  });

  it("leaves an outbound draft unsent until it is relayed", () => {
    // On a manual channel the AI can write but not send. Until a human says
    // they've relayed it, the message hasn't reached anyone — and the
    // reply-rate stat depends on that distinction being real.
    importSample(csv(MARK));
    const id = listLeads()[0].id;

    const draft = appendMessage({
      leadId: id, channel: "whatsapp", direction: "outbound",
      body: "Hi Mark, what are you using proxies for?", sentBy: "ai", sent: false,
    })!;
    expect(draft.sent_at).toBeNull();
    expect(pendingDraft(id)!.id).toBe(draft.id);

    expect(markMessageSent(draft.id)!.sent_at).not.toBeNull();
    expect(pendingDraft(id)).toBeNull();
    // Marking twice must not move the timestamp.
    expect(markMessageSent(draft.id)).toBeNull();
  });

  it("can discard a draft, but never a message that was sent", () => {
    importSample(csv(MARK));
    const id = listLeads()[0].id;

    const draft = appendMessage({
      leadId: id, channel: "whatsapp", direction: "outbound",
      body: "first attempt", sentBy: "ai", sent: false,
    })!;
    expect(discardDraft(draft.id)).toBe(true);
    expect(listMessages(id)).toHaveLength(0);

    const sent = appendMessage({
      leadId: id, channel: "whatsapp", direction: "outbound",
      body: "this one went", sentBy: "ai", sent: true,
    })!;
    expect(discardDraft(sent.id)).toBe(false);
    expect(listMessages(id)).toHaveLength(1);
  });
});

describe("recordReview", () => {
  it("scores agreement and disagreement", () => {
    importSample(csv(MARK, PRINCE));
    const [a, b] = listLeads();

    recordReview({ leadId: a.id, characterId: null, aiVerdict: "qualified", humanVerdict: "qualified" });
    recordReview({ leadId: b.id, characterId: null, aiVerdict: "qualified", humanVerdict: "rejected" });

    expect(getReview(a.id)!.agreed).toBe(1);
    expect(getReview(b.id)!.agreed).toBe(0);
  });

  it("keeps the note and returns the latest review", () => {
    importSample(csv(MARK));
    const id = listLeads()[0].id;
    recordReview({
      leadId: id, characterId: null, aiVerdict: "rejected",
      humanVerdict: "qualified", note: "Use case was fine, the AI misread it.",
    });
    expect(getReview(id)!.note).toMatch(/misread/);
  });
});

describe("disableAllAi", () => {
  it("stops every active conversation at once", () => {
    importSample(csv(MARK, PRINCE));
    expect(disableAllAi()).toBe(2);
    expect(listLeads().every((l) => l.ai_enabled === 0)).toBe(true);
    expect(disableAllAi()).toBe(0);
  });
});

describe("row serialisation", () => {
  it("returns plain objects, not node:sqlite's null-prototype rows", () => {
    // React Server Components refuse to pass a null-prototype object to a
    // client component, and the failure surfaces as an opaque server exception
    // at render time, nowhere near the query that produced it. Every read goes
    // through plain()/plainAll() so that can't happen.
    importSample(csv(MARK));
    const lead = listLeads()[0];
    expect(Object.getPrototypeOf(lead)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(getLead(lead.id)!)).toBe(Object.prototype);

    const msg = appendMessage({
      leadId: lead.id, channel: "email", direction: "outbound",
      body: "hello", sentBy: "ai", sent: false,
    })!;
    expect(Object.getPrototypeOf(msg)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(listMessages(lead.id)[0])).toBe(Object.prototype);
    expect(Object.getPrototypeOf(pendingDraft(lead.id)!)).toBe(Object.prototype);

    recordReview({ leadId: lead.id, characterId: null, aiVerdict: "qualified", humanVerdict: "qualified" });
    expect(Object.getPrototypeOf(getReview(lead.id)!)).toBe(Object.prototype);
  });
});

describe("migrations", () => {
  it("are idempotent across reopens", () => {
    expect(() => _resetDbForTests(":memory:")).not.toThrow();
    expect(db().prepare("select count(*) as n from leads").get()).toEqual({ n: 0 });
  });
});
