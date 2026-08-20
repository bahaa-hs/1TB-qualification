"use client";

import { useState } from "react";
import Link from "next/link";
import { Tabs } from "@/components/ui/primitives";
import type { CharacterSpec } from "@/lib/playbook";
import type { PlaybookSpec } from "@/lib/playbookSpec";
import type { PromptLayer } from "@/lib/prompt";
import type { Criterion } from "@/lib/criteria";
import { PlaybookEditor } from "./PlaybookEditor";
import { CriteriaEditor } from "./CriteriaEditor";
import { RulesEditor } from "./RulesEditor";
import { CharacterEditor } from "./CharacterEditor";
import { TestPanel } from "./TestPanel";
import { ShareBrain } from "./ShareBrain";

export interface PlaybookItem {
  id: number;
  spec: PlaybookSpec;
}
export interface CharacterItem {
  id: number;
  spec: CharacterSpec;
  /** Null means "use the default connection". */
  connectionId: number | null;
}

export interface ConnectionItem {
  id: number;
  name: string;
  label: string;
  isDefault: boolean;
}

export function BrainWorkspace({
  playbooks,
  characters,
  connections,
  promptLayer,
  criteria,
  defaultPlaybookId,
  defaultCharacterId,
  hasAnyModel,
}: {
  playbooks: PlaybookItem[];
  characters: CharacterItem[];
  connections: ConnectionItem[];
  promptLayer: PromptLayer;
  criteria: Criterion[];
  defaultPlaybookId: number | null;
  defaultCharacterId: number | null;
  hasAnyModel: boolean;
}) {
  const [tab, setTab] = useState("playbook");

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold tracking-tight">Brain</h1>
        <ShareBrain />
      </div>
      <p className="mb-5 text-sm text-neutral-500">
        What the AI tries to find out, and how it sounds doing it.
      </p>

      <Tabs
        tabs={[
          { id: "playbook", label: "Playbook" },
          // Second, because the playbook refers to these — reading order
          // matches dependency order.
          { id: "criteria", label: "Qualification criteria" },
          { id: "rules", label: "Rules & knowledge" },
          { id: "characters", label: "Characters" },
          { id: "test", label: "Test conversation" },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div className="mt-5">
        {tab === "playbook" && (
          <PlaybookEditor
            playbooks={playbooks}
            criteria={criteria}
            defaultPlaybookId={defaultPlaybookId}
          />
        )}
        {tab === "criteria" && (
          <CriteriaEditor initial={criteria} playbooks={playbooks} promptLayer={promptLayer} />
        )}
        {tab === "rules" && (
          <RulesEditor
            initial={promptLayer}
            characters={characters}
            criteria={criteria}
            defaultCharacterId={defaultCharacterId}
          />
        )}
        {tab === "characters" && (
          <CharacterEditor
            characters={characters}
            defaultCharacterId={defaultCharacterId}
            connections={connections}
          />
        )}
        {tab === "test" &&
          (hasAnyModel ? (
            <TestPanel
              playbooks={playbooks}
              characters={characters}
              connections={connections}
              criteria={criteria}
              defaultPlaybookId={defaultPlaybookId}
              defaultCharacterId={defaultCharacterId}
            />
          ) : (
            <div className="rounded-xl border border-dashed border-neutral-300 bg-white p-10 text-center">
              <h2 className="text-base font-semibold text-neutral-900">No AI model connected</h2>
              <p className="mx-auto mt-2 max-w-sm text-sm text-neutral-500">
                Connect one in Settings, then come back here to see how it sounds before it talks to
                anyone real.
              </p>
              <Link
                href="/settings"
                className="mt-4 inline-block rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700"
              >
                Go to Settings
              </Link>
            </div>
          ))}
      </div>
    </div>
  );
}
