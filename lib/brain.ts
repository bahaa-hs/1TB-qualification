/**
 * Storage for playbooks and characters, plus the JSON export/import that lets
 * one person author the brain and the rest of the team use it.
 *
 * Everyone runs their own database, so this file is how a shared qualification
 * flow travels between teammates.
 */

import { db, plain, plainAll } from "./db";
import {
  DEFAULT_PLAYBOOK,
  upgradeSpec,
  validatePlaybook,
  type PlaybookSpec,
} from "./playbookSpec";
import {
  DEFAULT_CHARACTER,
  DEFAULT_MAX_WORDS,
  type CharacterSpec,
} from "./playbook";
import { getSetting, setSetting } from "./config";

export interface PlaybookRow {
  id: number;
  name: string;
  spec: string;
  version: number;
  archived: number;
  created_at: string;
}

export interface CharacterRow {
  id: number;
  name: string;
  persona: string;
  signature: string | null;
  constraints: string | null;
  /** Which model connection this character runs on. Null = the default one. */
  connection_id: number | null;
  archived: number;
  created_at: string;
}

export interface Playbook extends Omit<PlaybookRow, "spec"> {
  spec: PlaybookSpec;
}

// ─── Playbooks ───────────────────────────────────────────────────────────────

/**
 * Saved specs are upgraded on read rather than by a data migration.
 *
 * A v1 flat playbook or v2 workflow graph becomes v3 prose in memory; the next
 * save writes v3. Nothing to half-apply, and an old export imported months from
 * now still works.
 */
function toPlaybook(r: PlaybookRow): Playbook {
  return { ...r, spec: upgradeSpec(JSON.parse(r.spec)) };
}

export function listPlaybooks(): Playbook[] {
  const rows = plainAll<PlaybookRow>(
    db().prepare("select * from playbooks where archived = 0 order by id asc").all(),
  );
  return rows.map(toPlaybook);
}

export function getPlaybook(id: number): Playbook | null {
  const r = plain<PlaybookRow>(db().prepare("select * from playbooks where id = ?").get(id));
  return r ? toPlaybook(r) : null;
}

export function createPlaybook(spec: PlaybookSpec): number {
  const errors = validatePlaybook(spec);
  if (errors.length) throw new Error(errors.join(" "));
  const row = db()
    .prepare("insert into playbooks (name, spec, version) values (?, ?, 3) returning id")
    .get(spec.name, JSON.stringify(spec)) as { id: number };
  return row.id;
}

export function savePlaybook(id: number, spec: PlaybookSpec): void {
  const errors = validatePlaybook(spec);
  if (errors.length) throw new Error(errors.join(" "));
  db()
    .prepare("update playbooks set name = ?, spec = ?, version = 3 where id = ?")
    .run(spec.name, JSON.stringify(spec), id);
}

export function archivePlaybook(id: number): void {
  db().prepare("update playbooks set archived = 1 where id = ?").run(id);
}

// ─── Characters ──────────────────────────────────────────────────────────────

export function toCharacterSpec(r: CharacterRow): CharacterSpec {
  const c = r.constraints ? (JSON.parse(r.constraints) as Partial<CharacterSpec>) : {};
  return {
    name: r.name,
    persona: r.persona,
    signature: r.signature ?? undefined,
    maxWords: c.maxWords ?? DEFAULT_MAX_WORDS,
    emoji: c.emoji ?? false,
  };
}

export function listCharacters(): CharacterRow[] {
  const rows = db()
    .prepare("select * from characters where archived = 0 order by id asc")
    .all();
  return plainAll<CharacterRow>(rows);
}

export function getCharacter(id: number): CharacterRow | null {
  return plain<CharacterRow>(db().prepare("select * from characters where id = ?").get(id));
}

function assertCharacter(c: CharacterSpec): void {
  if (!c.name?.trim()) throw new Error("Give the character a name.");
  if (!c.persona?.trim()) throw new Error("Describe how the character should write.");
}

/** The JSON blob in characters.constraints. One place, so defaults can't drift. */
function packConstraints(c: CharacterSpec): string {
  return JSON.stringify({
    maxWords: c.maxWords ?? DEFAULT_MAX_WORDS,
    emoji: c.emoji ?? false,
  });
}

export function createCharacter(c: CharacterSpec, connectionId?: number | null): number {
  assertCharacter(c);
  const row = db()
    .prepare(`
      insert into characters (name, persona, signature, constraints, connection_id)
      values (?, ?, ?, ?, ?) returning id
    `)
    .get(
      c.name.trim(),
      c.persona.trim(),
      c.signature?.trim() || null,
      packConstraints(c),
      connectionId ?? null,
    ) as { id: number };
  return row.id;
}

export function saveCharacter(
  id: number,
  c: CharacterSpec,
  connectionId?: number | null,
): void {
  assertCharacter(c);
  db()
    .prepare(`
      update characters
      set name = ?, persona = ?, signature = ?, constraints = ?, connection_id = ?
      where id = ?
    `)
    .run(
      c.name.trim(),
      c.persona.trim(),
      c.signature?.trim() || null,
      packConstraints(c),
      connectionId ?? null,
      id,
    );
}

export function archiveCharacter(id: number): void {
  db().prepare("update characters set archived = 1 where id = ?").run(id);
}

// ─── Defaults ────────────────────────────────────────────────────────────────

/**
 * Seed one playbook and one character on first use, so the brain page is
 * something to edit rather than a blank canvas — and so a new teammate can run
 * a test conversation before authoring anything.
 */
export function ensureSeeded(): void {
  if (listPlaybooks().length === 0) {
    const id = createPlaybook(DEFAULT_PLAYBOOK);
    setSetting("brain.defaultPlaybookId", String(id));
  }
  if (listCharacters().length === 0) {
    const id = createCharacter(DEFAULT_CHARACTER);
    setSetting("brain.defaultCharacterId", String(id));
  }
}

/** The playbook/character a new conversation uses. Falls back to the first. */
export function defaultPlaybook(): Playbook | null {
  const id = Number(getSetting("brain.defaultPlaybookId"));
  return (Number.isFinite(id) && id ? getPlaybook(id) : null) ?? listPlaybooks()[0] ?? null;
}

export function defaultCharacter(): CharacterRow | null {
  const id = Number(getSetting("brain.defaultCharacterId"));
  return (Number.isFinite(id) && id ? getCharacter(id) : null) ?? listCharacters()[0] ?? null;
}

// ─── Share the brain between teammates ───────────────────────────────────────

export interface BrainExport {
  kind: "outreach-ai-brain";
  version: 1;
  playbooks: PlaybookSpec[];
  characters: CharacterSpec[];
}

export function exportBrain(): BrainExport {
  return {
    kind: "outreach-ai-brain",
    version: 1,
    playbooks: listPlaybooks().map((p) => p.spec),
    characters: listCharacters().map(toCharacterSpec),
  };
}

export function importBrain(raw: unknown): { playbooks: number; characters: number } {
  const data = raw as Partial<BrainExport>;
  if (!data || data.kind !== "outreach-ai-brain") {
    throw new Error("That doesn't look like an Outreach AI brain export.");
  }
  if (data.version !== 1) {
    throw new Error(`Unsupported export version ${String(data.version)}.`);
  }

  // Validate everything before writing anything — a half-applied import would
  // leave the brain in a state nobody authored.
  const playbooks = data.playbooks ?? [];
  const characters = data.characters ?? [];
  for (const [i, p] of playbooks.entries()) {
    const errors = validatePlaybook(upgradeSpec(p));
    if (errors.length) throw new Error(`Playbook ${i + 1} ("${p?.name}"): ${errors.join(" ")}`);
  }
  for (const [i, c] of characters.entries()) {
    if (!c?.name?.trim() || !c?.persona?.trim()) {
      throw new Error(`Character ${i + 1} is missing a name or persona.`);
    }
  }

  // Replace by name rather than duplicating, so re-importing an updated brain
  // updates in place instead of leaving two "Proxy qualification v1"s behind.
  const conn = db();
  conn.exec("begin");
  try {
    for (const raw of playbooks) {
      // Upgrade before writing, not just before validating — an export made
      // before the workflow graph existed is still a valid thing to import.
      const p = upgradeSpec(raw);
      const existing = listPlaybooks().find((x) => x.spec.name === p.name);
      if (existing) savePlaybook(existing.id, p);
      else createPlaybook(p);
    }
    for (const c of characters) {
      const existing = listCharacters().find((x) => x.name === c.name);
      if (existing) saveCharacter(existing.id, c);
      else createCharacter(c);
    }
    conn.exec("commit");
  } catch (e) {
    conn.exec("rollback");
    throw e;
  }
  return { playbooks: playbooks.length, characters: characters.length };
}
