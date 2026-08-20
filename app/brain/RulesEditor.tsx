"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Field, Select, Textarea } from "@/components/ui/primitives";
import { PLACEHOLDERS, type PromptLayer } from "@/lib/prompt";
import type { Criterion } from "@/lib/criteria";
import { previewPromptAction, resetPromptLayerAction, savePromptLayerAction } from "./actions";
import type { CharacterItem } from "./BrainWorkspace";

type PreviewBlock = { heading: string; body: string; source: "yours" | "automatic" };

const SECTIONS: {
  key: keyof PromptLayer;
  label: string;
  hint: string;
  rows: number;
  placeholder?: string;
}[] = [
  {
    key: "identity",
    label: "Identity",
    hint: "The opening line of every prompt. Who the bot is and who it works for.",
    rows: 2,
  },
  {
    key: "knowledge",
    label: "What the AI knows",
    hint: "Product facts it may state, and what it must not claim.",
    rows: 4,
  },
  {
    key: "rules",
    label: "Ground rules",
    hint: "How it behaves on every turn. One rule per line.",
    rows: 7,
  },
  {
    key: "opening",
    label: "First message only",
    hint: "Extra instructions that apply to the opening message and nowhere else. Leave blank for none.",
    rows: 3,
  },
  {
    key: "neverSay",
    label: "Never say",
    hint: "One phrase per line. A reply containing any of them is rejected and rewritten, not sent.",
    rows: 4,
    placeholder: "AI assistant\nreply HUMAN",
  },
];

/**
 * The general instruction layer that governs every character.
 *
 * The live preview is the point of this screen: it shows the exact prompt that
 * will be sent, with your text and the automatic parts labelled separately. The
 * old hardcoded version had an instruction sitting below the character's Voice
 * and quietly overriding it — the only way to catch that class of problem is to
 * be able to see the assembled result.
 */
export function RulesEditor({
  initial,
  characters,
  criteria,
  defaultCharacterId,
}: {
  initial: PromptLayer;
  characters: CharacterItem[];
  criteria: Criterion[];
  defaultCharacterId: number | null;
}) {
  const [layer, setLayer] = useState<PromptLayer>(initial);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const [preview, setPreview] = useState<PreviewBlock[] | null>(null);
  const [previewFor, setPreviewFor] = useState<number>(
    defaultCharacterId ?? characters[0]?.id ?? 0,
  );
  const [firstMessage, setFirstMessage] = useState(true);

  const set = (k: keyof PromptLayer) => (e: { target: { value: string } }) => {
    setLayer((l) => ({ ...l, [k]: e.target.value }));
    setSaved(false);
    setPreview(null);
  };

  const dirty = (Object.keys(initial) as (keyof PromptLayer)[]).some(
    (k) => layer[k] !== initial[k],
  );

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="space-y-4">
        <p className="text-sm text-neutral-500">
          These apply to every character. The character&rsquo;s own Voice sits inside this, so
          anything here is a rule all of them follow.
        </p>

        {SECTIONS.map((s) => (
          <Field key={s.key} label={s.label} hint={s.hint}>
            <Textarea
              rows={s.rows}
              value={layer[s.key]}
              placeholder={s.placeholder}
              onChange={set(s.key)}
              className="font-mono text-xs"
            />
          </Field>
        ))}

        <details className="rounded-lg border border-neutral-200 bg-white p-3">
          <summary className="cursor-pointer text-xs font-medium text-neutral-600">
            Placeholders you can use
          </summary>
          <dl className="mt-2 space-y-1">
            {PLACEHOLDERS.map((p) => (
              <div key={p.token} className="grid grid-cols-[170px_minmax(0,1fr)] gap-2 text-xs">
                <dt>
                  <code className="text-neutral-700">{p.token}</code>
                </dt>
                <dd className="text-neutral-500">{p.describes}</dd>
              </div>
            ))}
          </dl>
          {/* The two namespaces are shown apart because they behave
              differently: a built-in is always known, a criterion is only known
              once the AI has worked it out — and a line mentioning one it
              hasn't is dropped rather than half-rendered. */}
          {criteria.length > 0 && (
            <>
              <h4 className="mt-3 text-xs font-medium text-neutral-600">
                From your qualification criteria
              </h4>
              <dl className="mt-2 space-y-1">
                {criteria.map((c) => (
                  <div key={c.key} className="grid grid-cols-[170px_minmax(0,1fr)] gap-2 text-xs">
                    <dt>
                      <code className="text-neutral-700">{`{{${c.key}}}`}</code>
                    </dt>
                    <dd className="text-neutral-500">
                      {c.label}
                      <span className="text-neutral-400">
                        {" "}
                        — the line is left out until this is known
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </details>

        {problems.length > 0 && (
          <ul className="space-y-1 rounded-lg border border-red-200 bg-red-50 px-3 py-2">
            {problems.map((e) => (
              <li key={e} className="text-sm text-red-800">
                {e}
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={pending || !dirty}
            onClick={() =>
              start(async () => {
                const errs = await savePromptLayerAction(layer);
                setProblems(errs);
                setSaved(errs.length === 0);
              })
            }
          >
            {pending ? "Saving…" : "Save"}
          </Button>
          {saved && <span className="text-xs text-green-700">Saved</span>}
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() =>
              start(async () => {
                if (!confirm("Put every section back to the shipped defaults?")) return;
                setLayer(await resetPromptLayerAction());
                setProblems([]);
                setSaved(true);
                setPreview(null);
              })
            }
          >
            Reset to defaults
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-40 flex-1">
            <Field label="Preview as">
              <Select
                value={previewFor}
                onChange={(e) => {
                  setPreviewFor(Number(e.target.value));
                  setPreview(null);
                }}
              >
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.spec.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <label className="flex items-center gap-1.5 pb-1.5 text-xs text-neutral-600">
            <input
              type="checkbox"
              checked={firstMessage}
              className="size-3.5 accent-neutral-900"
              onChange={() => {
                setFirstMessage((v) => !v);
                setPreview(null);
              }}
            />
            First message
          </label>
          <Button
            variant="secondary"
            className="mb-0.5"
            disabled={pending || !previewFor}
            onClick={() =>
              start(async () =>
                setPreview(await previewPromptAction(layer, previewFor, firstMessage)),
              )
            }
          >
            {pending ? "…" : "Show prompt"}
          </Button>
        </div>

        {preview ? (
          <div className="space-y-2 rounded-lg border border-neutral-200 bg-white p-3">
            <div className="flex items-center gap-2 text-xs text-neutral-500">
              <Badge tone="blue">yours</Badge>
              <Badge tone="gray">automatic</Badge>
              <span>— exactly what gets sent to the model.</span>
            </div>
            {preview.map((b, i) => (
              <div
                key={i}
                className={`rounded-md border-l-2 px-2 py-1.5 ${
                  b.source === "yours"
                    ? "border-blue-400 bg-blue-50/40"
                    : "border-neutral-300 bg-neutral-50"
                }`}
              >
                {b.heading && (
                  <div className="text-[11px] font-semibold tracking-wide text-neutral-500">
                    {b.heading}
                  </div>
                )}
                <pre className="whitespace-pre-wrap font-mono text-xs text-neutral-800">
                  {b.body}
                </pre>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-8 text-center text-sm text-neutral-400">
            Show the assembled prompt to see your text and the automatic parts in the order the
            model receives them.
          </div>
        )}
      </div>
    </div>
  );
}
