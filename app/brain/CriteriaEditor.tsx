"use client";

import { useMemo, useState, useTransition } from "react";
import { Badge, Button, Collapsible, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import {
  blankCriterion,
  placeholderTokens,
  validateRegistry,
  type Criterion,
  type CriterionValue,
} from "@/lib/criteria";
import type { PromptLayer } from "@/lib/prompt";
import { saveCriteriaAction } from "./actions";
import type { PlaybookItem } from "./BrainWorkspace";

/**
 * Where a criterion is referenced, so deleting one can't silently strand a
 * question that then never gets asked.
 *
 * Computed on the client from props the workspace already has — the full specs
 * and the prompt layer — rather than a server round trip, so it updates as you
 * type rather than after a save.
 */
interface Usage {
  where: string;
  how: string;
}

function findUsages(key: string, playbooks: PlaybookItem[], layer: PromptLayer): Usage[] {
  const out: Usage[] = [];
  const mentions = (text: string | undefined) =>
    Boolean(text && placeholderTokens(text).includes(key));

  for (const p of playbooks) {
    const spec = p.spec;
    if (spec.criteriaKeys.includes(key)) {
      out.push({ where: `${spec.name} · playbook`, how: "a fact to capture" });
    }
    if (mentions(spec.instructions)) {
      out.push({ where: `${spec.name} · playbook`, how: "a placeholder in the instructions" });
    }
  }

  const sections: [keyof PromptLayer, string][] = [
    ["identity", "Who the AI is"],
    ["knowledge", "What it knows"],
    ["rules", "Ground rules"],
    ["opening", "First message"],
  ];
  for (const [field, label] of sections) {
    if (mentions(layer[field])) out.push({ where: `Rules & knowledge · ${label}`, how: "a placeholder" });
  }

  return out;
}

const blankValue = (): CriterionValue => ({ value: "", label: "" });

export function CriteriaEditor({
  initial,
  playbooks,
  promptLayer,
}: {
  initial: Criterion[];
  playbooks: PlaybookItem[];
  promptLayer: PromptLayer;
}) {
  const [registry, setRegistry] = useState<Criterion[]>(() =>
    JSON.parse(JSON.stringify(initial)),
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  const problems = useMemo(() => validateRegistry(registry), [registry]);
  const usagesByKey = useMemo(
    () => new Map(registry.map((c) => [c.key, findUsages(c.key, playbooks, promptLayer)])),
    [registry, playbooks, promptLayer],
  );

  const touch = (next: Criterion[]) => {
    setRegistry(next);
    setSaved(false);
  };

  const patch = (index: number, fn: (draft: Criterion) => void) => {
    const next = JSON.parse(JSON.stringify(registry)) as Criterion[];
    fn(next[index]);
    touch(next);
  };

  function addCriterion() {
    const c = blankCriterion(registry);
    touch([...registry, c]);
    setEditing(c.key);
  }

  function remove(index: number) {
    touch(registry.filter((_, i) => i !== index));
    setEditing(null);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-sm text-neutral-500">
          The named facts the AI works out about a lead. Define them once here and every character and
          workflow uses the same ones — they show on the pipeline too. Drop one into any text as{" "}
          <code className="rounded bg-neutral-100 px-1 text-xs">{`{{use_case}}`}</code>.
        </p>
        <div className="flex items-center gap-2">
          {saved && <span className="text-xs text-green-700">Saved</span>}
          <Button
            disabled={pending}
            onClick={() =>
              start(async () => {
                const errs = await saveCriteriaAction(registry);
                setShowProblems(errs.length > 0);
                setSaved(errs.length === 0);
              })
            }
          >
            {pending ? "Saving…" : "Save criteria"}
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

      <ul className="space-y-3">
        {registry.map((c, i) => {
          const usages = usagesByKey.get(c.key) ?? [];
          const open = editing === c.key;
          return (
            <li key={i} className="rounded-lg border border-neutral-200 bg-white p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral">{c.kind === "choice" ? "one of a list" : "free text"}</Badge>
                <code className="text-xs text-neutral-500">{c.key}</code>
                <span className="text-sm font-medium text-neutral-900">{c.label || "Untitled"}</span>
                {c.showOnBoard && <Badge tone="blue">on the board</Badge>}
                <div className="ml-auto flex items-center gap-3">
                  <Badge tone={usages.length ? "gray" : "neutral"}>
                    {usages.length === 1 ? "1 use" : `${usages.length} uses`}
                  </Badge>
                  <button
                    type="button"
                    className="text-xs text-neutral-500 hover:text-neutral-900"
                    onClick={() => setEditing(open ? null : c.key)}
                  >
                    {open ? "Done" : "Edit"}
                  </button>
                  <button
                    type="button"
                    className="text-xs text-red-700 hover:underline disabled:cursor-not-allowed disabled:text-neutral-300 disabled:no-underline"
                    disabled={usages.length > 0}
                    title={
                      usages.length
                        ? "Remove it from the places below first"
                        : "Remove this criterion"
                    }
                    onClick={() => remove(i)}
                  >
                    Remove
                  </button>
                </div>
              </div>

              {open && (
                <div className="mt-3 space-y-3 border-t border-neutral-100 pt-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Name" hint="What a person sees">
                      <Input
                        value={c.label}
                        placeholder="Use case"
                        onChange={(e) => patch(i, (d) => (d.label = e.target.value))}
                      />
                    </Field>
                    <Field label="Key" hint="Used in conditions and as {{the_key}}">
                      <Input
                        className="font-mono text-xs"
                        value={c.key}
                        onChange={(e) => patch(i, (d) => (d.key = e.target.value))}
                      />
                    </Field>
                  </div>

                  <Field label="What it means" hint="The AI reads this. Say what it is and when to fill it.">
                    <Textarea
                      rows={2}
                      value={c.description}
                      placeholder="What the lead plans to use proxies for."
                      onChange={(e) => patch(i, (d) => (d.description = e.target.value))}
                    />
                  </Field>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Answers">
                      <Select
                        value={c.kind}
                        onChange={(e) =>
                          patch(i, (d) => {
                            d.kind = e.target.value === "choice" ? "choice" : "text";
                            d.values = d.kind === "choice" ? (d.values?.length ? d.values : [blankValue()]) : undefined;
                          })
                        }
                      >
                        <option value="choice">One of a list</option>
                        <option value="text">Free text</option>
                      </Select>
                    </Field>
                    <label className="flex items-end gap-2 pb-1.5 text-xs text-neutral-600">
                      <input
                        type="checkbox"
                        className="size-3.5 accent-neutral-900"
                        checked={c.showOnBoard}
                        onChange={() => patch(i, (d) => (d.showOnBoard = !d.showOnBoard))}
                      />
                      Show on the pipeline board
                    </label>
                  </div>

                  {c.kind === "choice" ? (
                    <div>
                      <h4 className="mb-1 text-xs font-semibold text-neutral-900">
                        The answers, and what each one means
                      </h4>
                      <p className="mb-2 text-xs text-neutral-500">
                        The definition is the glossary entry the AI reads. Without one, a small model
                        guesses between answers that sound alike.
                      </p>
                      <ul className="space-y-2">
                        {(c.values ?? []).map((v, vi) => (
                          <li key={vi} className="grid gap-1.5 sm:grid-cols-[9rem_9rem_1fr_auto] sm:items-start">
                            <Input
                              className="font-mono text-xs"
                              value={v.value}
                              placeholder="web_scraping"
                              onChange={(e) => patch(i, (d) => (d.values![vi].value = e.target.value))}
                            />
                            <Input
                              value={v.label}
                              placeholder="Web scraping"
                              onChange={(e) => patch(i, (d) => (d.values![vi].label = e.target.value))}
                            />
                            <Input
                              value={v.definition ?? ""}
                              placeholder="Crawling or harvesting data from websites at scale."
                              onChange={(e) =>
                                patch(i, (d) => (d.values![vi].definition = e.target.value || undefined))
                              }
                            />
                            <button
                              type="button"
                              className="justify-self-start pt-1.5 text-xs text-red-700 hover:underline"
                              onClick={() => patch(i, (d) => d.values!.splice(vi, 1))}
                            >
                              Remove
                            </button>
                          </li>
                        ))}
                      </ul>
                      <Button
                        variant="secondary"
                        className="mt-2"
                        onClick={() => patch(i, (d) => d.values!.push(blankValue()))}
                      >
                        Add an answer
                      </Button>
                    </div>
                  ) : (
                    <p className="rounded-md bg-neutral-50 px-2 py-2 text-xs text-neutral-600">
                      A free-text answer is only recorded when the lead&rsquo;s own words support it. If you
                      want the AI to <em>work something out</em> from what they mean, make it a list
                      instead.
                    </p>
                  )}

                  {usages.length > 0 && (
                    <Collapsible
                      summary={usages.length === 1 ? "Used in 1 place" : `Used in ${usages.length} places`}
                    >
                      <ul className="space-y-1">
                        {usages.map((u, ui) => (
                          <li key={ui} className="text-xs text-neutral-600">
                            {u.where} — {u.how}
                          </li>
                        ))}
                      </ul>
                    </Collapsible>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <Button variant="secondary" onClick={addCriterion}>
        Add a criterion
      </Button>
    </div>
  );
}
