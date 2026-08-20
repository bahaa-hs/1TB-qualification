/**
 * OpenAI-compatible adapter — covers OpenAI, OpenRouter, Groq, LM Studio,
 * llama.cpp and anything else exposing /chat/completions.
 *
 * The base URL is taken as given (including its /v1) rather than assembled,
 * because the vendors disagree: OpenAI is /v1, OpenRouter is /api/v1, LM Studio
 * is /v1 on a local port. Guessing would break two of the three.
 */

import { fetchWithTimeout } from "../http";
import {
  parseJsonLoose,
  type CompleteArgs,
  type LlmProvider,
  type ProviderConfig,
} from "./providers";

const TIMEOUT_MS = 120_000;

export function openAiProvider(config: ProviderConfig): LlmProvider {
  const base = (config.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");

  return {
    id: "openai-compatible",
    model: config.model,
    async complete(args: CompleteArgs): Promise<unknown> {
      if (!config.apiKey) {
        throw new Error("This provider needs an API key — add one in Settings.");
      }

      const send = (strict: boolean) =>
        fetchWithTimeout(
          `${base}/chat/completions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
              model: config.model,
              messages: [{ role: "system", content: args.system }, ...args.messages],
              max_tokens: args.maxTokens ?? 800,
              temperature: 0.4,
              response_format: {
                type: "json_schema",
                json_schema: { name: "turn", schema: args.schema, strict },
              },
            }),
          },
          TIMEOUT_MS,
        );

      let res = await send(true);
      // Plenty of compatible servers advertise json_schema but reject strict
      // mode, or reject the whole response_format. Step down rather than fail:
      // the response is validated by our own guardrails either way.
      if (res.status === 400) {
        res = await send(false);
      }

      const text = await res.text();
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Rejected the API key (HTTP ${res.status}) — check it in Settings.`);
      }
      if (res.status === 404) {
        throw new Error(
          `No model "${config.model}" at ${new URL(base).host}. Check the model name, and that the base URL includes the version path (e.g. https://api.openai.com/v1).`,
        );
      }
      if (res.status === 429) {
        throw new Error("Rate limited by the provider — wait a moment and try again.");
      }
      if (!res.ok) {
        throw new Error(`Provider HTTP ${res.status}: ${text.slice(0, 300)}`);
      }

      const body = parseJsonLoose(text, "The provider") as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
        error?: { message?: string };
      };
      if (body.error?.message) throw new Error(body.error.message);

      const choice = body.choices?.[0];
      if (choice?.finish_reason === "length") {
        throw new Error(
          "The model hit its token limit mid-answer. Shorten the playbook or raise the limit.",
        );
      }
      const content = choice?.message?.content;
      if (!content) throw new Error("The provider returned an empty response.");
      return parseJsonLoose(content, "The provider");
    },
  };
}
