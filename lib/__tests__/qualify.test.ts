import { describe, expect, it } from "vitest";
import { DEFAULT_CHARACTER } from "../playbook";
import { DEFAULT_PLAYBOOK } from "../playbookSpec";
import { DEFAULT_CRITERIA, targetedCriteria } from "../criteria";
import { buildDecision, runTurn, type TurnInput } from "../qualify";
import type { LlmProvider } from "../llm/providers";

/** A provider that returns canned responses, one per call. */
function fakeProvider(
  ...responses: unknown[]
): LlmProvider & { calls: number; systems: string[]; lastMessages: { role: string; content: string }[] } {
  const systems: string[] = [];
  let lastMessages: { role: string; content: string }[] = [];
  let calls = 0;
  return {
    id: "ollama",
    model: "fake",
    systems,
    get lastMessages() {
      return lastMessages;
    },
    get calls() {
      return calls;
    },
    async complete(args) {
      systems.push(args.system);
      lastMessages = args.messages;
      return responses[Math.min(calls++, responses.length - 1)];
    },
  } as LlmProvider & { calls: number; systems: string[]; lastMessages: { role: string; content: string }[] };
}

const targets = targetedCriteria(DEFAULT_CRITERIA, DEFAULT_PLAYBOOK.criteriaKeys);

const input = (over: Partial<TurnInput> = {}): TurnInput => ({
  playbook: DEFAULT_PLAYBOOK,
  criteria: DEFAULT_CRITERIA,
  targets,
  character: DEFAULT_CHARACTER,
  lead: { firstName: "Alex", companyWebsite: "example-scraper.com", expectedVolume: "1TB+" },
  collected: {},
  messagesSent: 0,
  history: [],
  ...over,
});

describe("the opening turn", () => {
  // Both were observed on the first live run against llama3.1:8b. With no
  // inbound message, neither extraction nor intent can be meaningful.

  it("ignores facts the model 'extracted' before the lead has said anything", async () => {
    const provider = fakeProvider({
      extracted: { target_sites: "example-scraper.com", monthly_volume: "1TB+" },
      reply: "Hi Alex, I'm an AI assistant. What are you using proxies for?",
      leadIntent: "answering",
      handoff: false,
    });
    const out = await runTurn(provider, input());
    expect(out.kind).toBe("reply");
    expect(out.collected).toEqual({});
  });

  it("ignores a leadIntent invented before the lead has spoken", async () => {
    const provider = fakeProvider({
      extracted: {},
      reply: "Hi Alex, what are you using proxies for?",
      leadIntent: "not_interested",
      handoff: false,
    });
    const out = await runTurn(provider, input());
    expect(out.kind === "reply" && out.leadIntent).toBe("answering");
    expect(out.kind === "reply" && out.handoff).toBe(false);
  });

  it("still requires the AI disclosure and escape hatch in the prompt", async () => {
    const provider = fakeProvider({ extracted: {}, reply: "Hi", leadIntent: "answering", handoff: false });
    await runTurn(provider, input());
    expect(provider.systems[0]).toMatch(/you are an AI assistant/i);
    expect(provider.systems[0]).toMatch(/reply HUMAN/);
  });

  it("teaches the glossary and labels form data as background", async () => {
    const provider = fakeProvider({ extracted: {}, reply: "Hi", leadIntent: "answering", handoff: false });
    await runTurn(provider, input());
    expect(provider.systems[0]).toMatch(/have NOT said any of this to you/);
    // The criterion definitions are taught inline now, not only in the schema.
    expect(provider.systems[0]).toMatch(/Crawling or harvesting data/);
  });
});

describe("subsequent turns", () => {
  const history = [
    { role: "assistant" as const, content: "What are you using proxies for?" },
    { role: "user" as const, content: "web scraping, mostly ecommerce" },
  ];

  it("merges what the lead actually said", async () => {
    const provider = fakeProvider({
      extracted: { use_case: "web_scraping" },
      reply: "Got it. Which sites are you targeting?",
      leadIntent: "answering",
      handoff: false,
    });
    const out = await runTurn(provider, input({ history, messagesSent: 1 }));
    expect(out.kind).toBe("reply");
    expect(out.collected.use_case).toBe("web_scraping");
  });

  it("keeps the first answer when a later turn restates it differently", async () => {
    const provider = fakeProvider({
      extracted: { use_case: "market_research" },
      reply: "Understood.",
      leadIntent: "answering",
      handoff: false,
    });
    const out = await runTurn(
      provider,
      input({ history, messagesSent: 2, collected: { use_case: "web_scraping" } }),
    );
    expect(out.collected.use_case).toBe("web_scraping");
  });

  it("passes the AI's handoff signal straight through", async () => {
    const provider = fakeProvider({
      extracted: {},
      reply: "Great, I'll bring in a colleague to take it from here.",
      leadIntent: "answering",
      handoff: true,
    });
    const out = await runTurn(provider, input({ history, messagesSent: 3 }));
    expect(out.kind === "reply" && out.handoff).toBe(true);
  });

  it("does not re-plan or spend a second call on a normal turn", async () => {
    const provider = fakeProvider({
      extracted: { use_case: "web_scraping" },
      reply: "Got it, which sites?",
      leadIntent: "answering",
      handoff: false,
    });
    const out = await runTurn(provider, input({ history, messagesSent: 1 }));
    expect(out.kind === "reply" && out.attempts).toBe(1);
    expect(provider.calls).toBe(1);
  });
});

describe("grounding — facts must come from the lead, not the context", () => {
  const history = [
    { role: "assistant" as const, content: "What are you using proxies for?" },
    { role: "user" as const, content: "We're doing web scraping, mainly ecommerce product pages" },
  ];

  it("drops a free-text fact the lead never said", async () => {
    const provider = fakeProvider({
      extracted: { use_case: "web_scraping", monthly_volume: "1TB+" },
      reply: "Got it.",
      leadIntent: "answering",
      handoff: false,
    });
    const out = await runTurn(provider, input({ history, messagesSent: 1 }));
    expect(out.collected.monthly_volume).toBeUndefined();
    expect(out.kind === "reply" && out.ungrounded).toEqual(['monthly_volume="1TB+"']);
  });

  it("keeps a free-text fact the lead did say", async () => {
    const provider = fakeProvider({
      extracted: { target_sites: "ecommerce product pages" },
      reply: "Noted.",
      leadIntent: "answering",
      handoff: false,
    });
    const out = await runTurn(
      provider,
      input({ history, messagesSent: 1, collected: { use_case: "web_scraping" } }),
    );
    expect(out.collected.target_sites).toBe("ecommerce product pages");
  });

  it("does not ground enum answers against the wording", async () => {
    const provider = fakeProvider({
      extracted: { use_case: "web_scraping" },
      reply: "Got it.",
      leadIntent: "answering",
      handoff: false,
    });
    const out = await runTurn(provider, input({ history, messagesSent: 1 }));
    expect(out.collected.use_case).toBe("web_scraping");
  });

  it("tolerates paraphrase rather than demanding an exact quote", async () => {
    const provider = fakeProvider({
      extracted: { target_sites: "Amazon and eBay listings" },
      reply: "Noted.",
      leadIntent: "answering",
      handoff: false,
    });
    const out = await runTurn(
      provider,
      input({
        history: [
          { role: "assistant", content: "Which sites?" },
          { role: "user", content: "mostly amazon and ebay, the listings pages" },
        ],
        messagesSent: 2,
        collected: { use_case: "web_scraping" },
      }),
    );
    expect(out.collected.target_sites).toBe("Amazon and eBay listings");
  });
});

describe("intent, corrected against the evidence", () => {
  const engaged = [
    { role: "assistant" as const, content: "What for?" },
    { role: "user" as const, content: "web scraping, mainly ecommerce product pages" },
  ];

  it("overrides 'not interested' when the lead just answered the question", async () => {
    const provider = fakeProvider({
      extracted: { use_case: "web_scraping" },
      reply: "Got it.",
      leadIntent: "not_interested",
      handoff: false,
    });
    const out = await runTurn(provider, input({ history: engaged, messagesSent: 1 }));
    expect(out.kind === "reply" && out.leadIntent).toBe("answering");
  });

  it("still honours a genuine brush-off", async () => {
    const provider = fakeProvider({
      extracted: {},
      reply: "No problem, I'll close this off.",
      leadIntent: "not_interested",
      handoff: false,
    });
    const out = await runTurn(
      provider,
      input({
        history: [
          { role: "assistant", content: "What for?" },
          { role: "user", content: "not interested, please remove me" },
        ],
        messagesSent: 1,
      }),
    );
    expect(out.kind === "reply" && out.leadIntent).toBe("not_interested");
  });

  it.each(["HUMAN", "can I talk to a person please", "I'd rather speak with someone real"])(
    "detects %j in code rather than trusting the classifier",
    async (text) => {
      const provider = fakeProvider({
        extracted: {},
        reply: "Of course.",
        leadIntent: "answering",
        handoff: false,
      });
      const out = await runTurn(
        provider,
        input({
          history: [
            { role: "assistant", content: "What for?" },
            { role: "user", content: text },
          ],
          messagesSent: 1,
        }),
      );
      expect(out.kind === "reply" && out.leadIntent).toBe("wants_human");
    },
  );
});

describe("chase messages (a lead who hasn't replied)", () => {
  it("produces a reply without extracting anything from the nudge", async () => {
    const provider = fakeProvider({
      // A well-behaved model wouldn't, but even if it claims a fact, the nudge
      // has no real inbound, so nothing is recorded.
      extracted: { use_case: "web_scraping" },
      reply: "Just following up on my note — happy to help whenever suits.",
      leadIntent: "answering",
      handoff: false,
    });
    const out = await runTurn(
      provider,
      input({
        history: [{ role: "assistant", content: "Hi Alex, what are you building?" }],
        messagesSent: 1,
        nudge: "The lead hasn't replied. Send a short follow-up.",
      }),
    );
    expect(out.kind).toBe("reply");
    expect(out.collected).toEqual({});
    // The nudge is delivered as the last thing to react to.
    expect(provider.lastMessages.at(-1)?.content).toMatch(/hasn't replied/i);
  });
});

describe("guardrail retry", () => {
  const history = [
    { role: "assistant" as const, content: "What for?" },
    { role: "user" as const, content: "scraping" },
  ];

  it("retries once, telling the model exactly what was wrong", async () => {
    const provider = fakeProvider(
      { extracted: {}, reply: "word ".repeat(300), leadIntent: "answering", handoff: false },
      { extracted: {}, reply: "Got it, thanks.", leadIntent: "answering", handoff: false },
    );
    const out = await runTurn(provider, input({ history, messagesSent: 1 }));
    expect(out.kind).toBe("reply");
    expect(out.kind === "reply" && out.attempts).toBe(2);
    expect(provider.systems[1]).toMatch(/previous attempt was rejected/);
    expect(provider.systems[1]).toMatch(/90-word limit/);
  });

  it("blocks rather than sending after a second failure", async () => {
    const provider = fakeProvider({
      extracted: {},
      reply: "Hi {{first_name}}, what are you scraping?",
      leadIntent: "answering",
      handoff: false,
    });
    const out = await runTurn(provider, input({ history, messagesSent: 1 }));
    expect(out.kind).toBe("blocked");
    expect(out.kind === "blocked" && out.errors.join(" ")).toMatch(/placeholder/);
    expect(out.kind === "blocked" && out.attempts).toBe(2);
  });
});

describe("buildDecision", () => {
  it("keeps the summary narrative — the facts are rendered from structured data", () => {
    const d = buildDecision(
      { use_case: "web_scraping", target_sites: "amazon", monthly_volume: "5TB" },
      "qualified",
      "The AI judged it had learned enough to hand over.",
    );
    expect(d.verdict).toBe("qualified");
    expect(d.summary).toBe("The AI judged it had learned enough to hand over.");
    expect(d.summary).not.toContain("amazon");
  });

  it("marks a rejection as rejected and leads with the reason", () => {
    const d = buildDecision({ use_case: "other" }, "rejected", "The lead said they aren't interested.");
    expect(d.verdict).toBe("rejected");
    expect(d.summary.startsWith("The lead said they aren't interested")).toBe(true);
  });

  it("says so plainly when nothing was learned", () => {
    const d = buildDecision({}, "rejected", "No reply to any message in the sequence.");
    expect(d.summary).toMatch(/didn't answer any qualification questions/);
  });
});
