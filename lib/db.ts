/**
 * SQLite data layer, built on Node's builtin `node:sqlite` (Node 24+).
 *
 * Why the builtin rather than better-sqlite3: this tool is installed by
 * teammates on their own Windows machines. better-sqlite3 is a native module,
 * and when a prebuilt binary doesn't exist for the installed Node ABI it falls
 * back to compiling from source, which needs MSVC build tools. The builtin has
 * no install step at all. The wrapper below is thin enough that swapping back
 * would touch only this file.
 *
 * The database lives at data/outreach.db, is per-person, and holds OAuth
 * refresh tokens and every lead transcript — hence data/ being gitignored.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const DB_PATH = process.env.OUTREACH_DB_PATH ?? join(process.cwd(), "data", "outreach.db");

let _db: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const conn = new DatabaseSync(DB_PATH);
  // WAL keeps the UI readable while the poll loop writes.
  conn.exec("pragma journal_mode = WAL");
  conn.exec("pragma foreign_keys = ON");
  conn.exec("pragma busy_timeout = 5000");
  migrate(conn);
  _db = conn;
  return conn;
}

/** Test hook: point at a scratch file (or ":memory:") and start clean. */
export function _resetDbForTests(path: string): DatabaseSync {
  _db?.close();
  const conn = new DatabaseSync(path);
  conn.exec("pragma foreign_keys = ON");
  migrate(conn);
  _db = conn;
  return conn;
}

// ─── Migrations ──────────────────────────────────────────────────────────────

/**
 * Migrations are plain SQL applied in order and recorded in `_migrations`, so
 * they run once and are safe on every boot. Append, never edit.
 */
const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "0001_init",
    sql: `
create table import_batches (
  id integer primary key,
  filename text not null,
  row_count integer not null default 0,
  skipped_count integer not null default 0,
  created_at text not null default (datetime('now'))
);

create table characters (
  id integer primary key,
  name text not null,
  persona text not null,
  signature text,
  constraints text,                          -- JSON: {maxWords, emoji, formality}
  archived integer not null default 0,
  created_at text not null default (datetime('now'))
);

create table playbooks (
  id integer primary key,
  name text not null,
  spec text not null,                        -- JSON, see lib/playbook.ts
  version integer not null default 1,
  archived integer not null default 0,
  created_at text not null default (datetime('now'))
);

create table mailboxes (
  id integer primary key,
  address text unique not null,
  refresh_token text not null,
  last_history_id text,
  is_default integer not null default 0,
  connected_at text not null default (datetime('now'))
);

create table leads (
  id integer primary key,
  submission_id text unique not null,
  import_batch_id integer references import_batches(id),

  first_name text, last_name text,
  email text,
  company_website text, linkedin_url text,
  preferred_channel text,                    -- email|whatsapp|telegram|linkedin
  whatsapp_e164 text, whatsapp_raw text,
  telegram_handle text, telegram_chat_id text,
  expected_volume text,

  raw_row text not null,                     -- original CSV row, verbatim JSON
  import_warnings text,                      -- JSON array of strings
  contact_edited_by text, contact_edited_at text,
  mailbox_id integer references mailboxes(id),

  stage text not null default 'fresh',
    -- fresh | outreached | replied | decision | handed_off | rejected | disqualified
  ai_enabled integer not null default 1,
  playbook_id integer references playbooks(id),
  character_id integer references characters(id),

  first_outreach_at text, last_inbound_at text,
  collected text not null default '{}',      -- JSON: objective_key -> value
  verdict text, verdict_summary text,
  turn_count integer not null default 0,
  last_error text,

  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);
create index leads_stage_idx on leads(stage);

-- The privacy boundary: a conversation is only touchable if it is here and not
-- revoked. See assertActiveThread().
create table lead_threads (
  id integer primary key,
  lead_id integer not null references leads(id) on delete cascade,
  channel text not null,
  external_id text not null,                 -- gmail threadId | tg chat_id | heyreach conversationId
  revoked_at text,
  created_at text not null default (datetime('now')),
  unique (channel, external_id)
);

create table lead_messages (
  id integer primary key,
  lead_id integer not null references leads(id) on delete cascade,
  channel text not null,
  direction text not null,                   -- inbound | outbound
  body text,
  external_message_id text,
  sent_by text,                              -- ai | human | lead
  created_at text not null default (datetime('now')),
  unique (channel, external_message_id)
);
create index lead_messages_lead_idx on lead_messages(lead_id, created_at);

create table decision_reviews (
  id integer primary key,
  lead_id integer not null references leads(id) on delete cascade,
  character_id integer references characters(id),
  ai_verdict text not null,
  human_verdict text not null,
  agreed integer not null,
  note text,
  reviewed_by text,
  reviewed_at text not null default (datetime('now'))
);

create table settings (
  key text primary key,
  value text not null,
  updated_at text not null default (datetime('now'))
);

create table sync_state (
  channel text primary key,
  cursor text,
  updated_at text not null default (datetime('now'))
);
`,
  },
  {
    name: "0002_message_sent_at",
    sql: `
-- On a manually relayed channel the AI can draft but cannot send: a human has
-- to copy the message into WhatsApp or wherever. sent_at distinguishes "the AI
-- wrote this" from "this actually reached the lead", which is what keeps the
-- reply-rate stat honest. Automated channels set it at send time.
alter table lead_messages add column sent_at text;
update lead_messages set sent_at = created_at where sent_at is null;
`,
  },
  {
    name: "0003_model_connections",
    sql: `
-- A named model endpoint. Characters point at one of these rather than the app
-- having a single global provider, so different characters can run different
-- models — two Ollama models, or a hosted one where it earns its cost.
--
-- A table rather than four fields on the character: an API key is entered once
-- and shared, and swapping a model is one edit instead of one per character.
create table model_connections (
  id integer primary key,
  name text unique not null,
  provider text not null,                    -- ollama | openai-compatible | anthropic
  base_url text not null,
  api_key text,
  model text not null,
  is_default integer not null default 0,
  created_at text not null default (datetime('now'))
);

alter table characters add column connection_id integer references model_connections(id);

-- Fold whatever is already configured into a connection called "Default", so an
-- existing setup keeps working without being reconfigured. Skipped when nothing
-- was set up (or when it lives in env vars, which still work as a fallback).
insert into model_connections (name, provider, base_url, api_key, model, is_default)
select 'Default',
       coalesce((select value from settings where key = 'llm.provider'), 'ollama'),
       coalesce((select value from settings where key = 'llm.baseUrl'), 'http://127.0.0.1:11434'),
       (select value from settings where key = 'llm.apiKey'),
       (select value from settings where key = 'llm.model'),
       1
where exists (select 1 from settings where key = 'llm.model');

update characters
set connection_id = (select id from model_connections where is_default = 1)
where connection_id is null;
`,
  },
  {
    name: "0004_workflow_steps",
    sql: `
-- Where a lead sits in the workflow graph.
--
-- Schema only: no data migration. A null current_step_id means "not placed
-- yet", and the engine derives the entry step from the lead's stage the first
-- time it looks. Converting saved playbooks happens lazily on read too
-- (upgradeSpec in lib/workflow.ts) — a migration that half-applies would leave
-- the brain in a state nobody authored.
alter table leads add column current_step_id text;

-- When the scheduler should next act on this lead. Null means "waiting on
-- something other than the clock" — a reply, or a human confirming a send.
alter table leads add column next_due_at text;

-- Which outreach step owns the reply branch for this lead.
--
-- After a message is sent the lead moves down the no-reply branch and sits in a
-- wait, so it is no longer *on* the step that sent it. Without this, a reply
-- arriving mid-wait has nothing to branch from. Recording it means a reply
-- routes correctly however far down the chase sequence the lead has drifted.
alter table leads add column reply_branch_step_id text;

create index leads_due_idx on leads(next_due_at) where next_due_at is not null;
`,
  },
  {
    name: "0005_criteria",
    sql: `
-- Qualification criteria: the named facts the AI collects about a lead.
--
-- A table rather than a JSON blob in settings, for the same reason
-- model_connections is one: these are user-authored named rows the UI lists,
-- edits one at a time and refers to by name from elsewhere. Two Brain tabs each
-- appending to a JSON blob would silently lose one of the additions.
--
-- \`key\` is the identifier used in {{placeholders}}, in workflow conditions and
-- as the key inside leads.collected — hence unique, and validated against the
-- same ^[a-z][a-z0-9_]{0,39}\$ rule objective keys have always used.
--
-- Schema only. The registry is seeded lazily from the playbooks already saved
-- (ensureCriteriaSeeded), not by SQL: a saved spec may be v1 or v2 shaped, and
-- branching on that in SQL is exactly the migration-that-half-applies this
-- codebase refuses on principle.
create table criteria (
  id integer primary key,
  key text unique not null,
  label text not null,
  kind text not null default 'text',        -- choice | text
  values_json text,                         -- [{value,label,definition}]; null for text
  description text not null default '',
  show_on_board integer not null default 0,
  sort_order integer not null default 0,
  created_at text not null default (datetime('now'))
);
`,
  },
  {
    name: "0006_scoring_language",
    sql: `
-- The language a lead is being handled in. Null means "mirror whatever they
-- write, defaulting to the playbook's language for the first message" — set
-- once we've seen an inbound, editable by hand. Feeds the reply-language
-- instruction and the board badge.
alter table leads add column language text;

-- Lead scoring. A single 0..100 number for sorting the pipeline, plus the
-- per-rule breakdown so a score is explainable rather than a bare figure.
-- Both null until the lead has been scored (no facts collected yet).
alter table leads add column score integer;
alter table leads add column score_breakdown text;  -- JSON: {rules:{id:points}, ai, band}

-- The scoring criteria, defined in their own Brain section. A table for the
-- same reason criteria and model_connections are: user-authored named rows the
-- UI lists and edits one at a time. Each rule reads one captured criterion (or
-- a lead attribute when criterion_key is null) and contributes points.
create table scoring_rules (
  id integer primary key,
  criterion_key text,                        -- which criterion this rule reads
  attribute text,                            -- lead attribute when criterion_key is null
  op text not null,                          -- is | is_any_of | is_set | contains | gte
  value text,                                -- JSON-encoded comparand
  points integer not null default 0,
  label text not null default '',
  sort_order integer not null default 0,
  created_at text not null default (datetime('now'))
);
`,
  },
];

function migrate(conn: DatabaseSync): void {
  conn.exec(
    "create table if not exists _migrations (name text primary key, applied_at text not null default (datetime('now')))",
  );
  const applied = new Set(
    conn.prepare("select name from _migrations").all().map((r) => String(r.name)),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    conn.exec("begin");
    try {
      conn.exec(m.sql);
      conn.prepare("insert into _migrations (name) values (?)").run(m.name);
      conn.exec("commit");
    } catch (e) {
      conn.exec("rollback");
      throw new Error(`Migration ${m.name} failed: ${(e as Error).message}`);
    }
  }
}

// ─── Row conversion ──────────────────────────────────────────────────────────

/**
 * node:sqlite hands back rows with a **null prototype**. React Server
 * Components refuse to serialize those across the boundary to a client
 * component — "Only plain objects, and a few built-ins, can be passed" — and
 * the failure surfaces as an opaque server exception at render time, nowhere
 * near the query.
 *
 * Every read below goes through these, so a row is a plain object by the time
 * anything else touches it.
 */
export function plain<T>(row: unknown): T | null {
  return row ? ({ ...(row as object) } as T) : null;
}

export function plainAll<T>(rows: unknown[]): T[] {
  return rows.map((r) => ({ ...(r as object) }) as T);
}

// ─── Row types ───────────────────────────────────────────────────────────────

export interface LeadRow {
  id: number;
  submission_id: string;
  import_batch_id: number | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  company_website: string | null;
  linkedin_url: string | null;
  preferred_channel: string | null;
  whatsapp_e164: string | null;
  whatsapp_raw: string | null;
  telegram_handle: string | null;
  telegram_chat_id: string | null;
  expected_volume: string | null;
  raw_row: string;
  import_warnings: string | null;
  contact_edited_by: string | null;
  contact_edited_at: string | null;
  mailbox_id: number | null;
  stage: Stage;
  ai_enabled: number;
  playbook_id: number | null;
  character_id: number | null;
  first_outreach_at: string | null;
  last_inbound_at: string | null;
  collected: string;
  verdict: string | null;
  verdict_summary: string | null;
  turn_count: number;
  last_error: string | null;
  /** @deprecated Vestigial from the workflow graph. Kept so old rows still read. */
  current_step_id: string | null;
  /** When the scheduler should next act. Null = waiting on a reply or a human. */
  next_due_at: string | null;
  /** @deprecated Vestigial from the workflow graph. Kept so old rows still read. */
  reply_branch_step_id: string | null;
  /** The language this lead is handled in. Null = mirror the lead / playbook default. */
  language: string | null;
  /** 0..100 lead score, or null before any facts are collected. */
  score: number | null;
  /** JSON breakdown of how `score` was reached. */
  score_breakdown: string | null;
  created_at: string;
  updated_at: string;
}

export type Stage =
  | "fresh"
  | "outreached"
  | "replied"
  | "decision"
  | "handed_off"
  | "rejected"
  | "disqualified";

export const TERMINAL_STAGES: Stage[] = ["handed_off", "rejected", "disqualified"];

export const STAGE_LABELS: Record<Stage, string> = {
  fresh: "Fresh applications",
  outreached: "Outreached",
  replied: "Replied",
  decision: "Decision",
  handed_off: "Handed to human",
  rejected: "Rejected",
  disqualified: "Disqualified",
};
