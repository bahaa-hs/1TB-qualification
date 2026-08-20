/**
 * The AI provider seam — server side.
 *
 * Each teammate picks their own model in Settings, so this is a core feature
 * rather than a hedge. All three adapters take the same JSON Schema and return
 * an object that satisfies it — the calling code never branches on provider.
 *
 * Schema conformance is necessary but not sufficient: a response can be valid
 * JSON of the right shape and still be unfit to send. That's what
 * validateTurnResponse() in lib/playbook.ts is for.
 *
 * Client components must import from ./providers instead — this module reaches
 * the database and cannot be bundled for the browser.
 */

import { getSetting } from "../config";
import { ollamaProvider } from "./ollama";
import { openAiProvider } from "./openai";
import { anthropicProvider } from "./anthropic";
import { PROVIDERS, type LlmProvider, type ProviderConfig, type ProviderId, type TestResult } from "./providers";

export * from "./providers";

export function currentProviderConfig(): ProviderConfig | null {
  const provider = getSetting("llm.provider") as ProviderId | undefined;
  const model = getSetting("llm.model");
  if (!provider || !model) return null;
  const fallback = PROVIDERS.find((p) => p.id === provider)?.defaultBaseUrl ?? "";
  return {
    provider,
    baseUrl: getSetting("llm.baseUrl") ?? fallback,
    apiKey: getSetting("llm.apiKey"),
    model,
  };
}

export function makeProvider(config: ProviderConfig): LlmProvider {
  switch (config.provider) {
    case "ollama":
      return ollamaProvider(config);
    case "openai-compatible":
      return openAiProvider(config);
    case "anthropic":
      return anthropicProvider(config);
    default:
      throw new Error(`Unknown AI provider "${config.provider}".`);
  }
}

/** The default provider, or a readable error telling the user to go set one up. */
export function llm(): LlmProvider {
  const config = currentProviderConfig();
  if (!config) throw new Error("No AI model configured yet — set one up in Settings.");
  return makeProvider(config);
}

/**
 * The provider a specific character should use.
 *
 * Kept here rather than in lib/connections.ts to avoid an import cycle —
 * connections imports this module for ProviderConfig and PROVIDERS.
 */
export function llmFor(config: ProviderConfig | null): LlmProvider {
  if (!config) {
    throw new Error(
      "This character has no AI model to use — add a connection in Settings and pick one on the character.",
    );
  }
  return makeProvider(config);
}

/**
 * One real schema-forced completion. Powers the Test button, and is
 * deliberately a genuine round trip rather than a ping — the failure worth
 * catching is "this model can't hold the JSON contract", which only shows up
 * when you ask it to.
 */
export async function testProvider(config: ProviderConfig): Promise<TestResult> {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["reply", "colour"],
    properties: {
      reply: { type: "string", description: "A one-sentence greeting." },
      colour: { type: "string", enum: ["red", "green", "blue"] },
    },
  };
  try {
    const raw = await makeProvider(config).complete({
      system: "You are a test harness. Reply with JSON matching the schema. Pick the colour green.",
      messages: [{ role: "user", content: "Say hello in one short sentence." }],
      schema,
      maxTokens: 200,
    });
    const r = raw as Record<string, unknown>;
    if (!r || typeof r !== "object" || typeof r.reply !== "string") {
      return {
        ok: false,
        detail:
          "Connected, but the model didn't return the JSON shape we asked for. It may be too small to follow a schema reliably — try a larger one.",
        sample: JSON.stringify(raw).slice(0, 400),
      };
    }
    return {
      ok: true,
      detail:
        r.colour === "green"
          ? `Working. ${config.model} answered and followed the schema.`
          : `Connected and returned valid JSON, but ignored an instruction (asked for "green", got "${String(r.colour)}"). It will probably still work, but watch the first few conversations.`,
      sample: String(r.reply).slice(0, 400),
    };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
