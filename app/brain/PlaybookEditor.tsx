"use client";

import { useMemo, useState, useTransition } from "react";
import { Badge, Button, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import type { Criterion } from "@/lib/criteria";
import { validatePlaybook, type PlaybookSpec } from "@/lib/playbookSpec";
import { savePlaybookAction } from "./actions";
import type { PlaybookItem } from "./BrainWorkspace";

/**
 * The playbook is prose the AI follows, not a graph any more. This edits the
 * instructions, which criteria to capture, the chase cadence and the message
 * cap. Everything the old canvas expressed as boxes and arrows is now sentences.
 */
export function PlaybookEditor({
  playbooks,
  criteria,
  defaultPlaybookId,
}: {
  playbooks: PlaybookItem[];
  criteria: Criterion[];
  defaultPlaybookId: number | null;
}) {
  const [selectedId, setSelectedId] = useState(defaultPlaybookId ?? playbooks[0]?.id ?? 0);
  const initial = playbooks.find((p) => p.id === selectedId)?.spec ?? playbooks[0]?.spec;
  const [spec, setSpec] = useState<PlaybookSpec>(() => structuredClone(initial));
  const [showProblems, setShowProblems] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  const knownKeys = useMemo(() => new Set(criteria.map((c) => c.key)), [criteria]);
  const problems = useMemo(() => validatePlaybook(spec, knownKeys), [spec, knownKeys]);

  function switchTo(id: number) {
    const next = playbooks.find((p) => p.id === id);
    if (!next) return;
    setSelectedId(id);
    setSpec(structuredClone(next.spec));
    setSaved(false);
    setShowProblems(false);
  }

  const patch = (fn: (draft: PlaybookSpec) => void) => {
    const next = structuredClone(spec);
    fn(next);
    setSpec(next);
    setSaved(false);
  };

  const targets = spec.criteriaKeys.length ? new Set(spec.criteriaKeys) : null;
  const toggleCriterion = (key: string) =>
    patch((d) => {
      // Empty means "all". Materialise the full list on the first toggle so a
      // deselect is unambiguous rather than silently meaning "everything but".
      const current = d.criteriaKeys.length ? d.criteriaKeys : criteria.map((c) => c.key);
      d.criteriaKeys = current.includes(key)
        ? current.filter((k) => k !== key)
        : [...current, key];
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-sm text-neutral-500">
          The instructions the AI follows on every conversation — how to open, what to learn, when to
          hand off. Plain prose; write it the way you&rsquo;d brief a new rep. Use{" "}
          <code className="rounded bg-neutral-100 px-1 text-xs">{`{{use_case}}`}</code> to drop in a
          criterion.
        </p>
        <div className="flex items-center gap-2">
          {playbooks.length > 1 && (
            <Select value={selectedId} onChange={(e) => switchTo(Number(e.target.value))}>
              {playbooks.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.spec.name}
                </option>
              ))}
            </Select>
          )}
          {saved && <span className="text-xs text-green-700">Saved</span>}
          <Button
            disabled={pending}
            onClick={() =>
              start(async () => {
                const errs = await savePlaybookAction(selectedId, spec);
                setShowProblems(errs.length > 0);
                setSaved(errs.length === 0);
              })
            }
          >
            {pending ? "Saving…" : "Save playbook"}
          </Button>
        </div>
      </div>

      {showProblems && problems.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-red-200 bg-red-50 px-3 py-2">
          {problems.map((e) => (
            <li key={e} className="text-sm text-red-800">
              {e}
            </li>
          ))}
        </ul>
      )}

      <Field label="Name">
        <Input value={spec.name} onChange={(e) => patch((d) => (d.name = e.target.value))} />
      </Field>

      <Field label="Instructions" hint="The AI reads this every turn and follows it.">
        <Textarea
          rows={14}
          className="font-mono text-xs leading-relaxed"
          value={spec.instructions}
          onChange={(e) => patch((d) => (d.instructions = e.target.value))}
        />
      </Field>

      <div>
        <h4 className="mb-1 text-xs font-semibold text-neutral-900">Facts to capture</h4>
        <p className="mb-2 text-xs text-neutral-500">
          Which qualification criteria this playbook tries to learn. None ticked means all of them.
        </p>
        <div className="flex flex-wrap gap-2">
          {criteria.map((c) => {
            const on = targets ? targets.has(c.key) : true;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => toggleCriterion(c.key)}
                className={`rounded-full border px-2.5 py-1 text-xs ${
                  on
                    ? "border-neutral-900 bg-neutral-900 text-white"
                    : "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-400"
                }`}
              >
                {c.label || c.key}
              </button>
            );
          })}
          {criteria.length === 0 && (
            <span className="text-xs text-neutral-400">
              No criteria yet — add some under Qualification criteria.
            </span>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Follow-ups" hint="Chase messages if no reply.">
          <Input
            type="number"
            min={0}
            value={spec.followUp.count}
            onChange={(e) => patch((d) => (d.followUp.count = Math.max(0, Number(e.target.value))))}
          />
        </Field>
        <Field label="Days between" hint="Gap before each chase.">
          <Input
            type="number"
            min={1}
            value={spec.followUp.everyDays}
            onChange={(e) =>
              patch((d) => (d.followUp.everyDays = Math.max(1, Number(e.target.value))))
            }
          />
        </Field>
        <Field label="Message cap" hint="Max AI messages, then hand over.">
          <Input
            type="number"
            min={1}
            value={spec.maxAiMessages}
            onChange={(e) => patch((d) => (d.maxAiMessages = Math.max(1, Number(e.target.value))))}
          />
        </Field>
      </div>

      <Field
        label="Opening language"
        hint="Language for the first message. Leave blank to match the lead (English until they reply)."
      >
        <Input
          value={spec.defaultLanguage}
          placeholder="e.g. English, Spanish, 中文"
          onChange={(e) => patch((d) => (d.defaultLanguage = e.target.value))}
        />
      </Field>

      <p className="text-xs text-neutral-400">
        <Badge tone="neutral">Note</Badge> Once a lead replies, the AI mirrors whatever language they
        write in, regardless of this setting.
      </p>
    </div>
  );
}
