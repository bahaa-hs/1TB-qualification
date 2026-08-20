import { describe, expect, it } from "vitest";
import { DEFAULT_CHARACTER } from "../playbook";
import { DEFAULT_CRITERIA, type Criterion } from "../criteria";
import {
  DEFAULT_PROMPT_LAYER,
  buildPromptParts,
  fillPlaceholders,
  neverSayList,
  renderSystemPrompt,
  type PromptLayer,
} from "../prompt";

const lead = { firstName: "Mark", companyWebsite: "techproxy.com", expectedVolume: "1TB+" };
const playbook = { instructions: "Open warmly, then find out what they need.", defaultLanguage: "" };
const targets = DEFAULT_CRITERIA;

const render = (layer: Partial<PromptLayer> = {}, isFirstMessage = true, collected = {}) =>
  renderSystemPrompt({
    layer: { ...DEFAULT_PROMPT_LAYER, ...layer },
    character: DEFAULT_CHARACTER,
    lead,
    playbook,
    targets,
    collected,
    isFirstMessage,
    criteria: DEFAULT_CRITERIA,
  });

describe("the shipped defaults", () => {
  it("still ask for an AI disclosure and an escape hatch on the first message", () => {
    const p = render();
    expect(p).toMatch(/you are an AI assistant/i);
    expect(p).toMatch(/reply HUMAN/);
  });

  it("drop the opening instructions on later turns", () => {
    expect(render({}, false)).not.toMatch(/reply HUMAN/);
  });

  it("carry the character's voice and limits", () => {
    const p = render();
    expect(p).toContain("Sam");
    expect(p).toMatch(/under 90 words/);
    expect(p).toMatch(/No emoji/);
  });

  it("carry the playbook instructions", () => {
    const p = render();
    expect(p).toContain("YOUR PLAYBOOK");
    expect(p).toContain("Open warmly");
  });

  it("teach the criteria to capture, with their tokens", () => {
    const p = render();
    expect(p).toContain("use_case");
    expect(p).toContain("web_scraping");
  });

  it("label the form data as background so it isn't re-recorded", () => {
    expect(render()).toMatch(/have NOT said any of this to you/);
  });

  it("instruct on the reply language", () => {
    expect(render()).toContain("LANGUAGE");
  });

  it("end with the schema instruction", () => {
    expect(render().trimEnd().endsWith("Respond with JSON matching the required schema.")).toBe(true);
  });
});

describe("editing the layer", () => {
  it("replaces the identity line entirely", () => {
    const p = render({ identity: "You are {{character.name}} from Acme Widgets." });
    expect(p).toContain("You are Sam from Acme Widgets.");
    expect(p).not.toContain("Geonode, a proxy provider");
  });

  it("can remove the AI disclosure without touching code", () => {
    const p = render({ opening: "Open with a single short sentence and one question." });
    expect(p).not.toMatch(/AI assistant/i);
    expect(p).not.toMatch(/reply HUMAN/);
    expect(p).toContain("Open with a single short sentence");
  });

  it("omits a section left blank", () => {
    const p = render({ knowledge: "", rules: "" });
    expect(p).not.toContain("WHAT YOU KNOW");
    expect(p).not.toContain("RULES");
    expect(p).toContain("VOICE");
    expect(p).toContain("YOUR TASK THIS TURN");
  });

  it("renders the never-say list into the prompt as well as enforcing it", () => {
    const p = render({ neverSay: "guarantee\nunlimited bandwidth" });
    expect(p).toContain("NEVER SAY");
    expect(p).toContain("- guarantee");
    expect(p).toContain("- unlimited bandwidth");
  });
});

describe("ordering", () => {
  it("puts the opening instructions after the character's voice", () => {
    const p = render();
    expect(p.indexOf("VOICE")).toBeLessThan(p.indexOf("THIS IS THE FIRST MESSAGE"));
  });

  it("puts identity first and the schema instruction last", () => {
    const p = render();
    expect(p.startsWith("You are Sam")).toBe(true);
    expect(p.indexOf("RULES")).toBeLessThan(p.indexOf("Respond with JSON"));
  });

  it("puts the playbook before the task", () => {
    const p = render();
    expect(p.indexOf("YOUR PLAYBOOK")).toBeLessThan(p.indexOf("YOUR TASK THIS TURN"));
  });

  it("includes established facts only once there are any", () => {
    expect(render()).not.toContain("ESTABLISHED IN THIS CONVERSATION");
    expect(render({}, false, { use_case: "web_scraping" })).toContain(
      "ESTABLISHED IN THIS CONVERSATION",
    );
  });
});

describe("the language instruction", () => {
  const base = {
    layer: DEFAULT_PROMPT_LAYER,
    character: DEFAULT_CHARACTER,
    lead,
    targets,
    collected: {},
    criteria: DEFAULT_CRITERIA,
  };
  const lang = (over: Parameters<typeof buildPromptParts>[0]) =>
    buildPromptParts(over).automatic.find((b) => b.heading === "LANGUAGE")!.body;

  it("mirrors the lead's language when it is known", () => {
    expect(lang({ ...base, playbook, isFirstMessage: false, language: "Spanish" })).toMatch(/in Spanish/);
  });

  it("uses the playbook default for the opener before the lead has written", () => {
    expect(
      lang({ ...base, playbook: { instructions: "Hi", defaultLanguage: "French" }, isFirstMessage: true }),
    ).toMatch(/first message in French/);
  });

  it("defaults to mirroring, English until they reply", () => {
    expect(lang({ ...base, playbook, isFirstMessage: true })).toMatch(/same language the lead writes in/);
  });
});

describe("fillPlaceholders", () => {
  const ctx = { character: DEFAULT_CHARACTER, lead };

  it("substitutes character and lead values", () => {
    expect(fillPlaceholders("{{character.name}} / {{lead.firstName}}", ctx)).toBe("Sam / Mark");
    expect(fillPlaceholders("{{character.maxWords}}", ctx)).toBe("90");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(fillPlaceholders("{{ character.name }}", ctx)).toBe("Sam");
  });

  it("leaves an unknown placeholder visible rather than blanking it", () => {
    expect(fillPlaceholders("Hi {{lead.frstName}}", ctx)).toBe("Hi {{lead.frstName}}");
  });

  it("falls back to a greeting when the lead has no name", () => {
    expect(fillPlaceholders("Hi {{lead.firstName}}", { character: DEFAULT_CHARACTER, lead: {} })).toBe(
      "Hi there",
    );
  });
});

describe("neverSayList", () => {
  it("splits on newlines and drops blanks", () => {
    expect(neverSayList({ ...DEFAULT_PROMPT_LAYER, neverSay: "one\n\n  two  \n" })).toEqual(["one", "two"]);
  });

  it("is empty by default", () => {
    expect(neverSayList(DEFAULT_PROMPT_LAYER)).toEqual([]);
  });
});

describe("buildPromptParts", () => {
  it("separates what you wrote from what the code adds", () => {
    const parts = buildPromptParts({
      layer: DEFAULT_PROMPT_LAYER,
      character: DEFAULT_CHARACTER,
      lead,
      playbook,
      targets,
      collected: {},
      isFirstMessage: true,
      criteria: DEFAULT_CRITERIA,
    });
    const autoHeadings = parts.automatic.map((b) => b.heading);
    expect(autoHeadings).toContain("VOICE");
    expect(autoHeadings).toContain("YOUR PLAYBOOK");
    expect(autoHeadings).toContain("THE LEAD");
    expect(autoHeadings).toContain("YOUR TASK THIS TURN");
    expect(autoHeadings).toContain("LIMITS");

    const yourHeadings = parts.editable.map((b) => b.heading);
    expect(yourHeadings).toContain("WHAT YOU KNOW");
    expect(yourHeadings).toContain("RULES");
    expect(yourHeadings).toContain("THIS IS THE FIRST MESSAGE");
  });
});

describe("criteria as placeholders", () => {
  const criteria: Criterion[] = [
    {
      key: "use_case",
      label: "Use case",
      kind: "choice",
      description: "What they need proxies for",
      showOnBoard: true,
      values: [{ value: "web_scraping", label: "Web scraping" }],
    },
  ];
  const ctx = { character: DEFAULT_CHARACTER, lead, criteria };

  it("resolves a criterion token to its label", () => {
    expect(
      fillPlaceholders("They said {{use_case}}", { ...ctx, collected: { use_case: "web_scraping" } }),
    ).toBe("They said Web scraping");
  });

  it("leaves the token alone when this lead has no value yet", () => {
    expect(fillPlaceholders("They said {{use_case}}", { ...ctx, collected: {} })).toBe(
      "They said {{use_case}}",
    );
  });

  it("still resolves the built-in tokens after widening the charset", () => {
    expect(fillPlaceholders("{{character.name}} {{lead.firstName}}", ctx)).toBe("Sam Mark");
  });

  it("strips braces out of a substituted value", () => {
    const out = fillPlaceholders("Site: {{lead.company}}", {
      character: DEFAULT_CHARACTER,
      lead: { firstName: "Mark", companyWebsite: "a{{b}}c" },
    });
    expect(out).toBe("Site: abc");
  });
});

describe("playbook instructions holding a placeholder", () => {
  const criteria: Criterion[] = [
    {
      key: "use_case",
      label: "Use case",
      kind: "choice",
      description: "",
      showOnBoard: false,
      values: [{ value: "web_scraping", label: "Web scraping" }],
    },
  ];

  const parts = (over: { collected?: Record<string, string>; withCriteria?: boolean } = {}) =>
    buildPromptParts({
      layer: DEFAULT_PROMPT_LAYER,
      character: DEFAULT_CHARACTER,
      lead,
      playbook: { instructions: "You said {{use_case}} — which sites?" },
      targets: criteria,
      collected: over.collected ?? {},
      isFirstMessage: false,
      criteria: over.withCriteria === false ? undefined : criteria,
    });

  const playbookBody = (p: ReturnType<typeof buildPromptParts>) =>
    p.automatic.find((b) => b.heading === "YOUR PLAYBOOK")!.body;

  it("fills the instructions when the value is known", () => {
    const p = parts({ collected: { use_case: "web_scraping" } });
    expect(playbookBody(p)).toContain("You said Web scraping");
    expect(playbookBody(p)).not.toContain("{{");
  });

  it("drops the line and reports it when the value isn't known yet", () => {
    const p = parts({ collected: {} });
    expect(p.automatic.find((b) => b.heading === "YOUR PLAYBOOK")).toBeUndefined();
    expect(p.waiting.map((w) => w.tokens).flat()).toContain("use_case");
  });

  it("leaves tokens alone entirely when no registry is supplied", () => {
    const p = parts({ collected: {}, withCriteria: false });
    expect(p.waiting).toEqual([]);
    expect(playbookBody(p)).toContain("{{use_case}}");
  });

  it("renders established facts by their glossary names", () => {
    const block = buildPromptParts({
      layer: DEFAULT_PROMPT_LAYER,
      character: DEFAULT_CHARACTER,
      lead,
      playbook,
      targets: criteria,
      collected: { use_case: "web_scraping" },
      isFirstMessage: false,
      criteria,
    }).automatic.find((b) => b.heading === "ESTABLISHED IN THIS CONVERSATION")!;
    expect(block.body).toBe("- Use case: Web scraping");
  });
});
