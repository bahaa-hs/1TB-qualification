/**
 * Ollama adapter — the local, private option.
 *
 * Uses the native /api/chat endpoint rather than Ollama's OpenAI-compatible
 * shim, because `format: <json schema>` there is a first-class constrained
 * decode: the model physically cannot emit tokens that break the schema. The
 * shim's response_format is looser.
 */

import { fetchWithTimeout } from "../http";
import {
  parseJsonLoose,
  type CompleteArgs,
  type LlmProvider,
  type ProviderConfig,
} from "./providers";

// Local inference on a laptop GPU is slow, and the first call after an idle
// period also pays for loading the model into VRAM.
const TIMEOUT_MS = 180_000;

export function ollamaProvider(config: ProviderConfig): LlmProvider {
  const base = (config.baseUrl || "http://127.0.0.1:11434").replace(/\/+$/, "");

  return {
    id: "ollama",
    model: config.model,
    async complete(args: CompleteArgs): Promise<unknown> {
      let res: Response;
      try {
        res = await fetchWithTimeout(
          `${base}/api/chat`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: config.model,
              messages: [{ role: "system", content: args.system }, ...args.messages],
              format: args.schema,
              stream: false,
              options: { temperature: 0.4, num_predict: args.maxTokens ?? 800 },
            }),
          },
          TIMEOUT_MS,
        );
      } catch (e) {
        const msg = (e as Error).message;
        if (/ECONNREFUSED|fetch failed|failed:/i.test(msg)) {
          throw new Error(
            `Can't reach Ollama at ${base}. Is it running? Start it from the Start menu, or run "ollama serve".`,
          );
        }
        throw e;
      }

      const text = await res.text();
      if (res.status === 404) {
        throw new Error(
          `Ollama doesn't have the model "${config.model}". Run: ollama pull ${config.model}`,
        );
      }
      if (!res.ok) {
        throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 300)}`);
      }

      const body = parseJsonLoose(text, "Ollama") as {
        message?: { content?: string };
        error?: string;
      };
      if (body.error) throw new Error(`Ollama: ${body.error}`);
      const content = body.message?.content;
      if (!content) throw new Error("Ollama returned an empty response.");
      return parseJsonLoose(content, "Ollama");
    },
  };
}
