import {
  defaultCharacter,
  defaultPlaybook,
  ensureSeeded,
  listCharacters,
  listPlaybooks,
  toCharacterSpec,
} from "@/lib/brain";
import { defaultConnection, listConnections, providerConfigFor } from "@/lib/connections";
import { loadPromptLayer } from "@/lib/promptStore";
import { ensureCriteriaSeeded, listCriteria } from "@/lib/criteriaStore";
import { BrainWorkspace } from "./BrainWorkspace";

export const dynamic = "force-dynamic";
export const metadata = { title: "Brain — Outreach AI" };

export default function BrainPage() {
  // First visit gets a working playbook and character to edit rather than a
  // blank canvas — and something to run the test panel against immediately.
  ensureSeeded();
  // Harvested from the playbooks already saved, so an existing install lands
  // with its own criteria already defined rather than a blank page.
  ensureCriteriaSeeded();

  const playbooks = listPlaybooks();
  const characters = listCharacters();
  const connections = listConnections();
  const fallback = defaultConnection();

  return (
    <BrainWorkspace
      playbooks={playbooks.map((p) => ({ id: p.id, spec: p.spec }))}
      characters={characters.map((c) => ({
        id: c.id,
        spec: toCharacterSpec(c),
        connectionId: c.connection_id,
      }))}
      connections={connections.map((c) => ({
        id: c.id,
        name: c.name,
        label: `${c.name} — ${c.provider} · ${c.model}`,
        isDefault: c.is_default === 1,
      }))}
      promptLayer={loadPromptLayer()}
      criteria={listCriteria()}
      defaultPlaybookId={defaultPlaybook()?.id ?? null}
      defaultCharacterId={defaultCharacter()?.id ?? null}
      // The test panel needs to know a model exists at all; which one gets used
      // depends on the character selected inside it.
      hasAnyModel={Boolean(fallback ?? providerConfigFor(null))}
    />
  );
}
