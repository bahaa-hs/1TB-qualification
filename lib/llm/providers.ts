/**
 * Provider types and metadata, with no server-only imports.
 *
 * Kept separate from ./index because the Settings form is a client component:
 * importing PROVIDERS from the index would drag config → db → node:sqlite into
 * the browser bundle. Client code imports from here, server code from ./index.
 */

export type ProviderId = "ollama" | "openai-compatible" | "anthropic";

export const PROVIDERS: {
  id: ProviderId;
  label: string;
  hint: string;
  defaultBaseUrl: string;
}[] = [
  {
    id: "ollama",
    label: "Ollama (local)",
    hint: "Runs on your machine. Nothing leaves your laptop.",
    defaultBaseUrl: "http://127.0.0.1:11434",
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible",
    hint: "OpenAI, OpenRouter, Groq, LM Studio — anything with a /chat/completions endpoint. Transcripts go to that provider.",
    defaultBaseUrl: "https://api.openai.com/v1",
  },
  {
    id: "anthropic",
    label: "Claude",
    hint: "Anthropic's API. Transcripts go to Anthropic.",
    defaultBaseUrl: "https://api.anthropic.com",
  },
];

export interface CompleteArgs {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  /** JSON Schema the response must conform to. */
  schema: object;
  maxTokens?: number;
}

export interface LlmProvider {
  id: ProviderId;
  model: string;
  complete(args: CompleteArgs): Promise<unknown>;
}

export interface ProviderConfig {
  provider: ProviderId;
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export interface TestResult {
  ok: boolean;
  detail: string;
  /** What the model actually returned, so a misconfiguration is visible. */
  sample?: string;
}

/** Pull the first JSON object out of a text response. */
export function parseJsonLoose(text: string, provider: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some models wrap JSON in prose or a ```json fence despite being told not
    // to. Salvage the outermost object rather than failing the whole turn.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new Error(`${provider} did not return valid JSON. It replied: ${trimmed.slice(0, 200)}`);
  }
}
