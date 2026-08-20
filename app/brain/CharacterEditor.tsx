"use client";

import { useState, useTransition } from "react";
import { Button, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { DEFAULT_MAX_WORDS, type CharacterSpec } from "@/lib/playbook";
import { createCharacterAction, saveCharacterAction } from "./actions";
import type { CharacterItem } from "./BrainWorkspace";

const BLANK: CharacterSpec = {
  name: "",
  persona: "",
  signature: "",
  maxWords: 90,
  emoji: false,
};

export function CharacterEditor({
  characters,
  defaultCharacterId,
  connections,
}: {
  characters: CharacterItem[];
  defaultCharacterId: number | null;
  connections: { id: number; name: string; label: string; isDefault: boolean }[];
}) {
  const [selectedId, setSelectedId] = useState<number | "new">(
    defaultCharacterId ?? characters[0]?.id ?? "new",
  );
  const current = selectedId === "new" ? null : characters.find((c) => c.id === selectedId);
  const initial = current?.spec ?? BLANK;
  const [spec, setSpec] = useState<CharacterSpec>(() => ({ ...initial }));
  const [connectionId, setConnectionId] = useState<number | null>(current?.connectionId ?? null);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function switchTo(v: string) {
    const id = v === "new" ? ("new" as const) : Number(v);
    const next = id === "new" ? null : characters.find((c) => c.id === id);
    setSelectedId(id);
    setSpec({ ...(next?.spec ?? BLANK) });
    setConnectionId(next?.connectionId ?? null);
    setSaved(false);
    setError(null);
  }

  const set = <K extends keyof CharacterSpec>(k: K, v: CharacterSpec[K]) => {
    setSpec((s) => ({ ...s, [k]: v }));
    setSaved(false);
  };

  return (
    <div className="max-w-xl space-y-4">
      <Select value={String(selectedId)} onChange={(e) => switchTo(e.target.value)}>
        {characters.map((c) => (
          <option key={c.id} value={c.id}>
            {c.spec.name}
          </option>
        ))}
        <option value="new">+ New character</option>
      </Select>

      <Field label="Name" hint="Shown in stats, and used as the name they sign off with">
        <Input value={spec.name} onChange={(e) => set("name", e.target.value)} placeholder="Sam" />
      </Field>

      <Field
        label="Voice"
        hint="How they write. Be specific — this is the whole personality."
      >
        <Textarea
          rows={5}
          value={spec.persona}
          onChange={(e) => set("persona", e.target.value)}
          placeholder="Warm, direct and concise. Plain English, contractions, no corporate filler."
        />
      </Field>

      <Field label="Sign-off">
        <Input
          value={spec.signature ?? ""}
          onChange={(e) => set("signature", e.target.value)}
          placeholder="Sam, Geonode"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Word limit" hint="Replies over this are rejected, not sent">
          <Input
            type="number"
            min={20}
            max={400}
            value={spec.maxWords ?? DEFAULT_MAX_WORDS}
            onChange={(e) => set("maxWords", Number(e.target.value))}
          />
        </Field>
        <Field label="Emoji">
          <Select
            value={spec.emoji ? "yes" : "no"}
            onChange={(e) => set("emoji", e.target.value === "yes")}
          >
            <option value="no">Not allowed</option>
            <option value="yes">Allowed</option>
          </Select>
        </Field>
      </div>

      <Field
        label="AI model"
        hint={
          connections.length === 0
            ? "No models connected yet — add one in Settings."
            : "Which model writes this character's messages."
        }
      >
        <Select
          value={connectionId === null ? "" : String(connectionId)}
          onChange={(e) => {
            setConnectionId(e.target.value === "" ? null : Number(e.target.value));
            setSaved(false);
          }}
        >
          <option value="">
            {connections.find((c) => c.isDefault)
              ? `Default (${connections.find((c) => c.isDefault)!.name})`
              : "Default"}
          </option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
      </Field>

      <p className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
        Whether the opener says it&rsquo;s an AI, and everything else every character must do, is set
        once under <span className="font-medium">Rules &amp; knowledge</span>.
      </p>

      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-sm text-red-800">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError(null);
              try {
                if (selectedId === "new") {
                  const id = await createCharacterAction(spec, connectionId);
                  setSelectedId(id);
                } else {
                  await saveCharacterAction(selectedId, spec, connectionId);
                }
                setSaved(true);
              } catch (e) {
                setError((e as Error).message);
              }
            })
          }
        >
          {pending ? "Saving…" : selectedId === "new" ? "Create character" : "Save character"}
        </Button>
        {saved && <span className="text-xs text-green-700">Saved</span>}
      </div>
    </div>
  );
}
