/**
 * Anthropic adapter.
 *
 * Structured output via a forced tool call — the same technique
 * `leads AI/lib/anthropic.ts` uses. Raw fetch rather than @anthropic-ai/sdk to
 * keep the install light: this is one endpoint and the SDK would be the
 * heaviest dependency in the project.
 */

import { fetchWithTimeout } from "../http";
import {
  parseJsonLoose,
  type CompleteArgs,
  type LlmProvider,
  type ProviderConfig,
} from "./providers";

const TIMEOUT_MS = 120_000;
const API_VERSION = "2023-06-01";
const TOOL_NAME = "emit_turn";

export function anthropicProvider(config: ProviderConfig): LlmProvider {
  const base = (config.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");

  return {
    id: "anthropic",
    model: config.model,
    async complete(args: CompleteArgs): Promise<unknown> {
      if (!config.apiKey) {
        throw new Error("Claude needs an API key — add one in Settings.");
      }

      const res = await fetchWithTimeout(
        `${base}/v1/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": config.apiKey,
            "anthropic-version": API_VERSION,
          },
          body: JSON.stringify({
            model: config.model,
            max_tokens: args.maxTokens ?? 1024,
            temperature: 0.4,
            system: args.system,
            messages: args.messages,
            tools: [
              {
                name: TOOL_NAME,
                description: "Record this turn's extracted facts and the reply to send.",
                input_schema: args.schema,
              },
            ],
            // Forcing the tool is what makes the output structured rather than
            // prose that happens to contain JSON.
            tool_choice: { type: "tool", name: TOOL_NAME },
          }),
        },
        TIMEOUT_MS,
      );

      const text = await res.text();
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Anthropic rejected the API key (HTTP ${res.status}) — check Settings.`);
      }
      if (res.status === 404) {
        throw new Error(`Anthropic has no model "${config.model}". Check the model name.`);
      }
      if (res.status === 429) {
        throw new Error("Anthropic rate limited the request — wait a moment and try again.");
      }
      if (!res.ok) {
        throw new Error(`Anthropic HTTP ${res.status}: ${text.slice(0, 300)}`);
      }

      const body = parseJsonLoose(text, "Anthropic") as {
        content?: { type: string; name?: string; input?: unknown }[];
        stop_reason?: string;
        error?: { message?: string };
      };
      if (body.error?.message) throw new Error(`Anthropic: ${body.error.message}`);

      const call = body.content?.find((c) => c.type === "tool_use" && c.name === TOOL_NAME);
      if (!call?.input) {
        if (body.stop_reason === "max_tokens") {
          throw new Error("Claude hit its token limit mid-answer. Shorten the playbook.");
        }
        throw new Error("Claude did not return the expected structured output.");
      }
      return call.input;
    },
  };
}
