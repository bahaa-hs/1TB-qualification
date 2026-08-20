"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Field, Input, Select } from "@/components/ui/primitives";
import { PROVIDERS, type ProviderId, type TestResult } from "@/lib/llm/providers";
import {
  deleteConnectionAction,
  saveConnectionAction,
  setDefaultConnectionAction,
  testProviderAction,
} from "./actions";

export interface ConnectionView {
  id: number;
  name: string;
  provider: ProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  isDefault: boolean;
}

const MODEL_HINT: Record<ProviderId, string> = {
  ollama: "e.g. llama3.1:8b — must already be pulled (ollama pull …)",
  "openai-compatible": "e.g. gpt-4o-mini, or whatever your provider calls it",
  anthropic: "e.g. claude-sonnet-4-6",
};

const blank = (): ConnectionView => ({
  id: 0,
  name: "",
  provider: "ollama",
  baseUrl: PROVIDERS[0].defaultBaseUrl,
  apiKey: "",
  model: "",
  isDefault: false,
});

/**
 * Model connections.
 *
 * Characters point at one of these, so you can run a small local model for
 * routine leads and something stronger for the character that handles your best
 * ones — without re-entering an API key per character.
 */
export function Connections({ connections }: { connections: ConnectionView[] }) {
  const [editing, setEditing] = useState<ConnectionView | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const meta = editing ? PROVIDERS.find((p) => p.id === editing.provider)! : PROVIDERS[0];
  const needsKey = editing ? editing.provider !== "ollama" : false;

  function edit(c: ConnectionView | null) {
    setEditing(c ?? blank());
    setResult(null);
    setError(null);
  }

  function set<K extends keyof ConnectionView>(k: K, v: ConnectionView[K]) {
    setEditing((c) => (c ? { ...c, [k]: v } : c));
    setResult(null);
    setError(null);
  }

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-900">AI models</h2>
        {!editing && (
          <Button variant="secondary" onClick={() => edit(null)}>
            Add a model
          </Button>
        )}
      </div>
      <p className="mt-1 text-sm text-neutral-500">
        Each character picks one of these on the Brain page. The default is used when a character
        doesn&rsquo;t choose.
      </p>

      {connections.length === 0 && !editing && (
        <p className="mt-4 rounded-md border border-dashed border-neutral-300 px-3 py-4 text-center text-sm text-neutral-400">
          No models connected yet.
        </p>
      )}

      {connections.length > 0 && (
        <ul className="mt-4 space-y-2">
          {connections.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2"
            >
              <span className="text-sm font-medium text-neutral-900">{c.name}</span>
              {c.isDefault && <Badge tone="green">default</Badge>}
              <span className="text-xs text-neutral-500">
                {c.provider} · {c.model}
              </span>
              <div className="ml-auto flex items-center gap-1">
                {!c.isDefault && (
                  <button
                    type="button"
                    className="text-xs text-neutral-500 hover:text-neutral-900"
                    disabled={pending}
                    onClick={() => start(() => setDefaultConnectionAction(c.id))}
                  >
                    Make default
                  </button>
                )}
                <button
                  type="button"
                  className="rounded px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100"
                  onClick={() => edit(c)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="rounded px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      if (
                        !confirm(
                          `Delete "${c.name}"? Characters using it fall back to the default.`,
                        )
                      )
                        return;
                      await deleteConnectionAction(c.id);
                    })
                  }
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <div className="mt-4 space-y-3 rounded-lg border border-neutral-300 bg-neutral-50 p-3">
          <Field label="Name" hint="What you'll pick from on a character, e.g. “Local 8B” or “Claude”">
            <Input
              value={editing.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Local 8B"
            />
          </Field>

          <Field label="Provider" hint={meta.hint}>
            <Select
              value={editing.provider}
              onChange={(e) => {
                const id = e.target.value as ProviderId;
                const next = PROVIDERS.find((p) => p.id === id)!;
                setEditing((c) =>
                  c ? { ...c, provider: id, baseUrl: next.defaultBaseUrl } : c,
                );
                setResult(null);
              }}
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Base URL"
            hint={
              editing.provider === "openai-compatible"
                ? "Include the version path — OpenAI is /v1, OpenRouter is /api/v1."
                : undefined
            }
          >
            <Input value={editing.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} />
          </Field>

          {needsKey && (
            <Field label="API key">
              <Input
                type="password"
                value={editing.apiKey}
                onChange={(e) => set("apiKey", e.target.value)}
                placeholder="sk-…"
              />
            </Field>
          )}

          <Field label="Model" hint={MODEL_HINT[editing.provider]}>
            <Input value={editing.model} onChange={(e) => set("model", e.target.value)} />
          </Field>

          {error && (
            <p className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-sm text-red-800">
              {error}
            </p>
          )}

          {result && (
            <div
              className={`rounded-md border px-3 py-2 text-sm ${
                result.ok
                  ? "border-green-200 bg-green-50 text-green-900"
                  : "border-red-200 bg-red-50 text-red-900"
              }`}
            >
              <div className="flex items-start gap-2">
                <Badge tone={result.ok ? "green" : "red"}>{result.ok ? "OK" : "Failed"}</Badge>
                <span>{result.detail}</span>
              </div>
              {result.sample && (
                <p className="mt-2 border-t border-current/10 pt-2 text-xs opacity-80">
                  It said: “{result.sample}”
                </p>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              disabled={pending || !editing.model.trim()}
              onClick={() =>
                start(async () =>
                  setResult(
                    await testProviderAction({
                      provider: editing.provider,
                      baseUrl: editing.baseUrl,
                      apiKey: editing.apiKey || undefined,
                      model: editing.model,
                    }),
                  ),
                )
              }
            >
              {pending ? "Testing…" : "Test"}
            </Button>
            <Button
              disabled={pending || !editing.name.trim() || !editing.model.trim()}
              onClick={() =>
                start(async () => {
                  try {
                    await saveConnectionAction(editing.id || null, {
                      name: editing.name,
                      provider: editing.provider,
                      baseUrl: editing.baseUrl,
                      apiKey: editing.apiKey,
                      model: editing.model,
                    });
                    setEditing(null);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                })
              }
            >
              {pending ? "Saving…" : editing.id ? "Save" : "Add"}
            </Button>
            <Button variant="ghost" disabled={pending} onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
