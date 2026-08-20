"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Field, Select, Textarea } from "@/components/ui/primitives";
import type { Collected } from "@/lib/playbook";
import { establishedFacts, type Criterion } from "@/lib/criteria";
import { runTestTurnAction } from "./actions";
import type { CharacterItem, ConnectionItem, PlaybookItem } from "./BrainWorkspace";

type Msg = { role: "user" | "assistant"; content: string };
type Ending = { tone: "green" | "red" | "amber"; title: string; detail: string } | null;

/**
 * Run a full simulated qualification against the configured model.
 *
 * This is the safety net for the decision to send autonomously: read a handful
 * of these before pointing a new model at a real prospect, because the first
 * live message is also the first one that can't be taken back.
 */
export function TestPanel({
  playbooks,
  characters,
  connections,
  criteria,
  defaultPlaybookId,
  defaultCharacterId,
}: {
  playbooks: PlaybookItem[];
  characters: CharacterItem[];
  connections: ConnectionItem[];
  criteria: Criterion[];
  defaultPlaybookId: number | null;
  defaultCharacterId: number | null;
}) {
  const [playbookId, setPlaybookId] = useState(defaultPlaybookId ?? playbooks[0]?.id ?? 0);
  const [characterId, setCharacterId] = useState(defaultCharacterId ?? characters[0]?.id ?? 0);
  const [history, setHistory] = useState<Msg[]>([]);
  const [collected, setCollected] = useState<Collected>({});
  const [draft, setDraft] = useState("");
  const [ending, setEnding] = useState<Ending>(null);
  const [ungrounded, setUngrounded] = useState<string[]>([]);
  const [pending, start] = useTransition();

  const started = history.length > 0 || ending !== null;

  function reset() {
    setHistory([]);
    setCollected({});
    setDraft("");
    setEnding(null);
    setUngrounded([]);
  }

  function advance(nextHistory: Msg[]) {
    start(async () => {
      const outcome = await runTestTurnAction({
        playbookId,
        characterId,
        history: nextHistory,
        collected,
      });

      setCollected(outcome.collected);

      if (outcome.kind === "blocked") {
        setHistory(nextHistory);
        setEnding({
          tone: "amber",
          title: "Blocked — nothing would have been sent",
          detail: outcome.errors.join(" "),
        });
        return;
      }

      // A reply. Show it, then read the signals the engine would act on.
      setHistory([...nextHistory, { role: "assistant", content: outcome.reply }]);
      if (outcome.ungrounded?.length) {
        setUngrounded((u) => [...new Set([...u, ...outcome.ungrounded!])]);
      }
      if (outcome.leadIntent === "not_interested") {
        setEnding({ tone: "red", title: "Rejected", detail: "The lead said they aren't interested." });
      } else if (outcome.leadIntent === "wants_human") {
        setEnding({ tone: "green", title: "Handed to a human", detail: "The lead asked for a person." });
      } else if (outcome.handoff) {
        setEnding({
          tone: "green",
          title: "Handed to a human",
          detail: "The AI judged it had learned enough to hand over.",
        });
      }
    });
  }

  // Read through the glossary, so the badges say "Use case: Web scraping"
  // rather than showing raw tokens on both sides.
  const facts = establishedFacts(criteria, collected as Record<string, unknown>);

  const character = characters.find((c) => c.id === characterId);
  const connection =
    connections.find((c) => c.id === character?.connectionId) ??
    connections.find((c) => c.isDefault);
  const modelLabel = connection?.label ?? "the configured model";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Playbook">
          <Select
            value={playbookId}
            disabled={started}
            onChange={(e) => setPlaybookId(Number(e.target.value))}
          >
            {playbooks.map((p) => (
              <option key={p.id} value={p.id}>
                {p.spec.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Character">
          <Select
            value={characterId}
            disabled={started}
            onChange={(e) => setCharacterId(Number(e.target.value))}
          >
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.spec.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {/* Name the model this character actually runs on, so a comparison
          between two characters is a comparison between two models. */}
      <p className="text-xs text-neutral-400">
        Using {modelLabel}. Nothing here touches a real lead.
      </p>

      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        {history.length === 0 && !ending ? (
          <div className="py-6 text-center">
            <p className="text-sm text-neutral-500">
              Play the part of the lead and see how the conversation goes.
            </p>
            <Button className="mt-3" disabled={pending} onClick={() => advance([])}>
              {pending ? "Thinking…" : "Start the conversation"}
            </Button>
          </div>
        ) : (
          <ol className="space-y-2">
            {history.map((m, i) => (
              <li
                key={i}
                className={`rounded-lg p-3 text-sm ${
                  m.role === "assistant"
                    ? "bg-neutral-100 text-neutral-800"
                    : "border border-neutral-200 text-neutral-800"
                }`}
              >
                <div className="mb-1 text-xs font-medium text-neutral-500">
                  {m.role === "assistant" ? "AI" : "You (as the lead)"}
                </div>
                <p className="whitespace-pre-wrap">{m.content}</p>
              </li>
            ))}
            {pending && <li className="px-3 py-2 text-sm text-neutral-400">Thinking…</li>}
          </ol>
        )}

        {ending && (
          <div
            className={`mt-3 rounded-md border px-3 py-2 text-sm ${
              ending.tone === "green"
                ? "border-green-200 bg-green-50 text-green-900"
                : ending.tone === "red"
                  ? "border-red-200 bg-red-50 text-red-900"
                  : "border-amber-200 bg-amber-50 text-amber-900"
            }`}
          >
            <div className="font-medium">{ending.title}</div>
            <p className="mt-0.5">{ending.detail}</p>
          </div>
        )}

        {started && !ending && (
          <div className="mt-3 space-y-2 border-t border-neutral-100 pt-3">
            <Textarea
              rows={2}
              value={draft}
              placeholder="Reply as the lead would…"
              disabled={pending}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && draft.trim() && !pending) {
                  e.preventDefault();
                  advance([...history, { role: "user", content: draft.trim() }]);
                  setDraft("");
                }
              }}
            />
            <div className="flex items-center gap-2">
              <Button
                disabled={pending || !draft.trim()}
                onClick={() => {
                  advance([...history, { role: "user", content: draft.trim() }]);
                  setDraft("");
                }}
              >
                Send
              </Button>
              <span className="text-xs text-neutral-400">Enter to send</span>
            </div>
          </div>
        )}
      </div>

      {ungrounded.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <span className="font-medium">Made up and discarded:</span> {ungrounded.join(", ")}.
          <span className="opacity-80">
            {" "}
            The model claimed the lead said these when they didn&rsquo;t. A model doing this often
            is one to replace.
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-start gap-2">
        <span className="mt-1 text-xs text-neutral-400">Learned so far:</span>
        {facts.length === 0 ? (
          <span className="mt-1 text-xs text-neutral-400">nothing yet</span>
        ) : (
          facts.map((f) => (
            <Badge key={f.key} tone="blue">
              {f.label}: {f.display}
            </Badge>
          ))
        )}
        {started && (
          <Button variant="ghost" className="ml-auto" onClick={reset} disabled={pending}>
            Start over
          </Button>
        )}
      </div>
    </div>
  );
}
