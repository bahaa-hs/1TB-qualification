/**
 * Storage for qualification criteria.
 *
 * Split out of lib/criteria.ts for the same reason promptStore.ts is split out
 * of prompt.ts: this file imports ./db, which imports node:sqlite, and a client
 * component that pulls it in fails the build. The editor imports the pure half.
 * lib/__tests__/client-boundary.test.ts enforces it.
 */

import { db, plain, plainAll } from "./db";
import {
  DEFAULT_CRITERIA,
  validateCriterion,
  type Criterion,
  type CriteriaRegistry,
  type CriterionValue,
} from "./criteria";

export interface CriterionRow {
  id: number;
  key: string;
  label: string;
  kind: string;
  values_json: string | null;
  description: string;
  show_on_board: number;
  sort_order: number;
  created_at: string;
}

function toCriterion(r: CriterionRow): Criterion {
  return {
    key: r.key,
    label: r.label,
    kind: r.kind === "choice" ? "choice" : "text",
    values: r.values_json ? (safeParse(r.values_json) ?? undefined) : undefined,
    description: r.description ?? "",
    showOnBoard: r.show_on_board === 1,
  };
}

function safeParse(json: string): CriterionValue[] | null {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as CriterionValue[]) : null;
  } catch {
    return null;
  }
}

export function listCriteria(): CriteriaRegistry {
  const rows = plainAll<CriterionRow>(
    db().prepare("select * from criteria order by sort_order asc, id asc").all(),
  );
  return rows.map(toCriterion);
}

export function getCriterion(key: string): Criterion | null {
  const r = plain<CriterionRow>(db().prepare("select * from criteria where key = ?").get(key));
  return r ? toCriterion(r) : null;
}

/**
 * Replace the whole registry in one transaction.
 *
 * The editor saves the list as a unit, the way the workflow editor saves a
 * spec, so a rename and a reorder land together rather than as a sequence of
 * writes that can be interrupted half-way.
 */
export function saveCriteria(next: CriteriaRegistry): void {
  const errors = next.flatMap((c) => validateCriterion(c, next));
  if (errors.length) throw new Error(errors.join(" "));

  const conn = db();
  conn.exec("begin");
  try {
    const keep = new Set(next.map((c) => c.key));
    for (const row of plainAll<CriterionRow>(conn.prepare("select * from criteria").all())) {
      if (!keep.has(row.key)) conn.prepare("delete from criteria where id = ?").run(row.id);
    }
    const upsert = conn.prepare(
      `insert into criteria (key, label, kind, values_json, description, show_on_board, sort_order)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict (key) do update set
         label = excluded.label,
         kind = excluded.kind,
         values_json = excluded.values_json,
         description = excluded.description,
         show_on_board = excluded.show_on_board,
         sort_order = excluded.sort_order`,
    );
    next.forEach((c, i) => {
      upsert.run(
        c.key,
        c.label.trim(),
        c.kind,
        c.kind === "choice" ? JSON.stringify(c.values ?? []) : null,
        c.description?.trim() ?? "",
        c.showOnBoard ? 1 : 0,
        i,
      );
    });
    conn.exec("commit");
  } catch (e) {
    conn.exec("rollback");
    throw e;
  }
}

/** How many leads already hold a value for this key. Shown before a delete. */
export function countLeadsWithValue(key: string): number {
  // The quoted path form, so a key can never be read as a JSON path expression.
  const row = db()
    .prepare(
      `select count(*) as n from leads
       where json_extract(collected, '$."' || ? || '"') is not null`,
    )
    .get(key) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Seed the registry from what's already saved.
 *
 * Reads the raw playbook JSON rather than going through listPlaybooks(), which
 * would recurse back through upgradeSpec, and harvests one criterion per
 * distinct objective key — carrying the question across as the description and
 * the inline options as the answer list. An existing install therefore lands
 * with its own five criteria already defined, including any the user edited,
 * rather than a blank page or a set of defaults that don't match their workflow.
 *
 * Idempotent: only creates keys the registry doesn't already have.
 */
export function ensureCriteriaSeeded(): void {
  const existing = new Set(listCriteria().map((c) => c.key));
  const harvested = harvestFromPlaybooks();
  const seed = [...harvested, ...DEFAULT_CRITERIA];

  const insert = db().prepare(
    `insert into criteria (key, label, kind, values_json, description, show_on_board, sort_order)
     values (?, ?, ?, ?, ?, ?, ?)`,
  );
  let order = existing.size;
  for (const c of seed) {
    if (existing.has(c.key)) continue;
    existing.add(c.key);
    insert.run(
      c.key,
      c.label,
      c.kind,
      c.kind === "choice" ? JSON.stringify(c.values ?? []) : null,
      c.description,
      c.showOnBoard ? 1 : 0,
      order++,
    );
  }
}

/** Objective keys and their inline options, from every saved playbook spec. */
function harvestFromPlaybooks(): Criterion[] {
  const rows = plainAll<{ spec: string }>(
    db().prepare("select spec from playbooks where archived = 0 order by id asc").all(),
  );
  const found = new Map<string, Criterion>();

  for (const row of rows) {
    let spec: unknown;
    try {
      spec = JSON.parse(row.spec);
    } catch {
      continue;
    }
    for (const o of objectivesIn(spec)) {
      if (found.has(o.key)) continue;
      const options = Array.isArray(o.options) ? o.options.filter((x) => typeof x === "string") : [];
      // Prefer the shipped glossary's wording when the key is one we know:
      // hand-written definitions beat a question reused as a description.
      const shipped = DEFAULT_CRITERIA.find((d) => d.key === o.key);
      if (shipped) {
        found.set(o.key, shipped);
        continue;
      }
      found.set(o.key, {
        key: o.key,
        label: titleCase(o.key),
        kind: options.length ? "choice" : "text",
        values: options.length ? options.map((v) => ({ value: v, label: titleCase(v) })) : undefined,
        description: typeof o.question === "string" ? o.question : "",
        showOnBoard: false,
      });
    }
  }
  return [...found.values()];
}

interface RawObjective {
  key: string;
  question?: unknown;
  options?: unknown;
}

/** Objectives in a v1 spec (flat) or a v2 spec (inside qualify steps). */
function objectivesIn(spec: unknown): RawObjective[] {
  const s = spec as { objectives?: unknown; steps?: unknown };
  const lists: unknown[] = [];
  if (Array.isArray(s?.objectives)) lists.push(s.objectives);
  if (Array.isArray(s?.steps)) {
    for (const step of s.steps as { objectives?: unknown }[]) {
      if (Array.isArray(step?.objectives)) lists.push(step.objectives);
    }
  }
  return lists
    .flat()
    .filter((o): o is RawObjective => Boolean(o) && typeof (o as RawObjective).key === "string");
}

function titleCase(key: string): string {
  const words = key.split("_").filter(Boolean);
  if (!words.length) return key;
  return words.map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}
