/**
 * Lead data layer.
 *
 * Two patterns here matter more than the rest:
 *
 *  1. claimStage() — a conditional UPDATE used as a compare-and-set, lifted from
 *     `leads AI/lib/supabase.ts`. A null return means "someone else got there
 *     first, do nothing". It is also where `ai_enabled` is checked, so a queued
 *     AI turn cannot land after a human has taken the conversation over.
 *
 *  2. assertActiveThread() — the single chokepoint every inbound message passes
 *     through. If a conversation isn't an allowlisted, unrevoked lead thread,
 *     nothing downstream ever sees it. This is what enforces "the tool only has
 *     access to conversations with leads from the CSV".
 */

import { db, plain, plainAll, type LeadRow, type Stage, TERMINAL_STAGES } from "./db";
import type { Channel, ParsedLead } from "./csv";

// ─── Import ──────────────────────────────────────────────────────────────────

export interface ImportSummary {
  batchId: number;
  inserted: number;
  updated: number;
  skipped: number;
  withWarnings: number;
}

/**
 * Upsert on submission_id so re-uploading the same export is idempotent.
 *
 * Hand-edited contact details win over the CSV: if someone fixed a mangled
 * phone number in the UI, a re-import must not quietly undo that. We refresh
 * only the fields a human hasn't touched.
 */
export function importLeads(filename: string, parsed: ParsedLead[], skipped: number): ImportSummary {
  const conn = db();
  const batch = conn
    .prepare(
      "insert into import_batches (filename, row_count, skipped_count) values (?, ?, ?) returning id",
    )
    .get(filename, parsed.length, skipped) as { id: number };

  const existing = conn.prepare(
    "select id, contact_edited_at from leads where submission_id = ?",
  );
  const insert = conn.prepare(`
    insert into leads (
      submission_id, import_batch_id, first_name, last_name, email,
      company_website, linkedin_url, preferred_channel, whatsapp_e164,
      whatsapp_raw, telegram_handle, expected_volume, raw_row, import_warnings
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Only touched when the contact block has NOT been hand-edited.
  const refresh = conn.prepare(`
    update leads set
      first_name = ?, last_name = ?, email = ?, company_website = ?,
      linkedin_url = ?, preferred_channel = ?, whatsapp_e164 = ?,
      whatsapp_raw = ?, telegram_handle = ?, expected_volume = ?,
      raw_row = ?, import_warnings = ?, import_batch_id = ?,
      updated_at = datetime('now')
    where id = ?
  `);
  // Hand-edited leads still get provenance refreshed, never contact fields.
  const refreshRawOnly = conn.prepare(
    "update leads set raw_row = ?, import_batch_id = ?, updated_at = datetime('now') where id = ?",
  );

  let inserted = 0;
  let updated = 0;
  let withWarnings = 0;

  conn.exec("begin");
  try {
    for (const l of parsed) {
      const warnings = l.warnings.length ? JSON.stringify(l.warnings) : null;
      const rawRow = JSON.stringify(l.rawRow);
      const prior = existing.get(l.submissionId) as
        | { id: number; contact_edited_at: string | null }
        | undefined;

      if (!prior) {
        insert.run(
          l.submissionId, batch.id, l.firstName, l.lastName, l.email,
          l.companyWebsite, l.linkedinUrl, l.preferredChannel, l.whatsappE164,
          l.whatsappRaw, l.telegramHandle, l.expectedVolume, rawRow, warnings,
        );
        inserted++;
        if (warnings) withWarnings++;
      } else if (prior.contact_edited_at) {
        // Hand-edited: keep the correction and, importantly, don't re-raise the
        // warning the human already resolved. Counting it here would nag about
        // a lead that is already fixed on every future import.
        refreshRawOnly.run(rawRow, batch.id, prior.id);
        updated++;
      } else {
        refresh.run(
          l.firstName, l.lastName, l.email, l.companyWebsite, l.linkedinUrl,
          l.preferredChannel, l.whatsappE164, l.whatsappRaw, l.telegramHandle,
          l.expectedVolume, rawRow, warnings, batch.id, prior.id,
        );
        updated++;
        if (warnings) withWarnings++;
      }
    }
    conn.exec("commit");
  } catch (e) {
    conn.exec("rollback");
    throw e;
  }

  return { batchId: batch.id, inserted, updated, skipped, withWarnings };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export function listLeads(): LeadRow[] {
  const rows = db()
    .prepare("select * from leads order by created_at desc, id desc")
    .all();
  return plainAll<LeadRow>(rows);
}

export function getLead(id: number): LeadRow | null {
  const row = db().prepare("select * from leads where id = ?").get(id);
  return plain<LeadRow>(row);
}

export function leadWarnings(lead: LeadRow): string[] {
  if (!lead.import_warnings) return [];
  try {
    const v = JSON.parse(lead.import_warnings);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function leadCollected(lead: LeadRow): Record<string, unknown> {
  try {
    const v = JSON.parse(lead.collected);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ─── Contact editing ─────────────────────────────────────────────────────────

export interface ContactEdit {
  email?: string | null;
  whatsappE164?: string | null;
  telegramHandle?: string | null;
  linkedinUrl?: string | null;
  companyWebsite?: string | null;
  preferredChannel?: Channel | null;
}

/**
 * Hand-edit a lead's contact details. Stamps the edit so a later CSV re-import
 * won't overwrite it, and clears any import warning that the edit resolves.
 */
export function updateContact(id: number, edit: ContactEdit, editedBy: string): LeadRow | null {
  const lead = getLead(id);
  if (!lead) return null;

  const next = {
    email: edit.email !== undefined ? edit.email : lead.email,
    whatsapp_e164: edit.whatsappE164 !== undefined ? edit.whatsappE164 : lead.whatsapp_e164,
    telegram_handle:
      edit.telegramHandle !== undefined ? edit.telegramHandle : lead.telegram_handle,
    linkedin_url: edit.linkedinUrl !== undefined ? edit.linkedinUrl : lead.linkedin_url,
    company_website:
      edit.companyWebsite !== undefined ? edit.companyWebsite : lead.company_website,
    preferred_channel:
      edit.preferredChannel !== undefined ? edit.preferredChannel : lead.preferred_channel,
  };

  // A supplied phone clears the "mangled number" warning; a supplied email
  // clears the "no email" one.
  let warnings = leadWarnings(lead);
  if (next.whatsapp_e164) warnings = warnings.filter((w) => !/^Phone number/.test(w));
  if (next.email) warnings = warnings.filter((w) => !/^No email address/.test(w));

  const row = db()
    .prepare(`
      update leads set
        email = ?, whatsapp_e164 = ?, telegram_handle = ?, linkedin_url = ?,
        company_website = ?, preferred_channel = ?, import_warnings = ?,
        contact_edited_by = ?, contact_edited_at = datetime('now'),
        updated_at = datetime('now')
      where id = ? returning *
    `)
    .get(
      next.email, next.whatsapp_e164, next.telegram_handle, next.linkedin_url,
      next.company_website, next.preferred_channel,
      warnings.length ? JSON.stringify(warnings) : null,
      editedBy, id,
    );
  return plain<LeadRow>(row);
}

// ─── Stage machine ───────────────────────────────────────────────────────────

/**
 * Atomically move a lead between stages. Returns the updated row, or null if
 * the lead was not in one of `from` (someone else moved it first).
 *
 * `requireAiEnabled` is what makes human takeover safe: pass true for anything
 * the AI initiates, and a turn queued before the takeover simply loses the race.
 */
export function claimStage(
  leadId: number,
  from: Stage[],
  to: Stage,
  opts: { requireAiEnabled?: boolean } = {},
): LeadRow | null {
  const placeholders = from.map(() => "?").join(", ");
  const aiClause = opts.requireAiEnabled ? "and ai_enabled = 1" : "";
  const row = db()
    .prepare(`
      update leads set stage = ?, last_error = null, updated_at = datetime('now')
      where id = ? and stage in (${placeholders}) ${aiClause}
      returning *
    `)
    .get(to, leadId, ...from);
  const lead = plain<LeadRow>(row);

  // Reaching a terminal stage revokes every thread for the lead. This is the
  // "all access removed once qualification is done" requirement, and it has to
  // happen here rather than at a call site so it can never be forgotten.
  if (lead && TERMINAL_STAGES.includes(to)) revokeThreads(leadId);
  return lead;
}

export function setAiEnabled(leadId: number, enabled: boolean): void {
  db()
    .prepare("update leads set ai_enabled = ?, updated_at = datetime('now') where id = ?")
    .run(enabled ? 1 : 0, leadId);
}

/** Panic button: stop every AI conversation at once. */
export function disableAllAi(): number {
  const r = db()
    .prepare(
      "update leads set ai_enabled = 0, updated_at = datetime('now') where ai_enabled = 1",
    )
    .run();
  return Number(r.changes);
}

// ─── Workflow position ───────────────────────────────────────────────────────

/**
 * Move a lead onto a step.
 *
 * The single place `current_step_id` changes, so the things that must happen on
 * arrival can't be forgotten: the turn counter resets (a qualify node's
 * `maxTurns` counts turns *in that node*), and the wait is set from the step's
 * own delay. Stage still goes through claimStage separately — that's where
 * terminal-thread revocation lives.
 */
export function enterStep(
  leadId: number,
  stepId: string,
  delayMinutes: number | undefined,
): void {
  const due =
    delayMinutes && delayMinutes > 0
      ? `datetime('now', '+${Math.floor(delayMinutes)} minutes')`
      : "datetime('now')";
  db()
    .prepare(`
      update leads
      set current_step_id = ?, turn_count = 0, next_due_at = ${due},
          last_error = null, updated_at = datetime('now')
      where id = ?
    `)
    .run(stepId, leadId);
}

/** Park a lead: it's waiting on a reply or a human, not on the clock. */
export function clearDue(leadId: number): void {
  db()
    .prepare("update leads set next_due_at = null, updated_at = datetime('now') where id = ?")
    .run(leadId);
}

/**
 * Set when the scheduler should next act on this lead, `minutes` from now.
 *
 * Unlike enterStep this leaves the turn counter and (vestigial) step alone —
 * it's the plain follow-up timer the prose engine uses, with no graph position.
 */
export function setNextDue(leadId: number, minutes: number): void {
  const at = `datetime('now', '+${Math.max(0, Math.floor(minutes))} minutes')`;
  db()
    .prepare(`update leads set next_due_at = ${at}, updated_at = datetime('now') where id = ?`)
    .run(leadId);
}

/** Record the language a lead is being handled in (set from their first reply). */
export function setLanguage(leadId: number, language: string | null): void {
  db()
    .prepare("update leads set language = ?, updated_at = datetime('now') where id = ?")
    .run(language?.trim() || null, leadId);
}

export function setReplyBranch(leadId: number, stepId: string | null): void {
  db()
    .prepare("update leads set reply_branch_step_id = ?, updated_at = datetime('now') where id = ?")
    .run(stepId, leadId);
}

/**
 * Leads the scheduler should act on: due, still running, AI still in charge.
 *
 * Oldest first so a backlog after the app has been closed for a while is worked
 * in the order it accumulated.
 */
export function dueLeads(limit = 25): LeadRow[] {
  const placeholders = TERMINAL_STAGES.map(() => "?").join(", ");
  return plainAll<LeadRow>(
    db()
      .prepare(`
        select * from leads
        where next_due_at is not null
          and next_due_at <= datetime('now')
          and ai_enabled = 1
          and stage not in (${placeholders})
        order by next_due_at asc
        limit ?
      `)
      .all(...TERMINAL_STAGES, limit),
  );
}

export function setLeadError(leadId: number, message: string): void {
  db()
    .prepare("update leads set last_error = ?, updated_at = datetime('now') where id = ?")
    .run(message.slice(0, 2000), leadId);
}

// ─── Threads: the allowlist ──────────────────────────────────────────────────

export function addThread(leadId: number, channel: Channel, externalId: string): void {
  db()
    .prepare(
      `insert into lead_threads (lead_id, channel, external_id) values (?, ?, ?)
       on conflict (channel, external_id) do update set lead_id = excluded.lead_id, revoked_at = null`,
    )
    .run(leadId, channel, externalId);
}

export function revokeThreads(leadId: number): void {
  db()
    .prepare(
      "update lead_threads set revoked_at = datetime('now') where lead_id = ? and revoked_at is null",
    )
    .run(leadId);
}

/**
 * THE privacy chokepoint. Returns the lead a conversation belongs to, or null
 * if the tool has no business touching it.
 *
 * Callers must treat null as "drop silently" — never as "look it up another
 * way". Every inbound path (Gmail poll, HeyReach poll, Telegram getUpdates)
 * goes through this before any message body is fetched or stored.
 */
export function activeThreadLead(channel: Channel, externalId: string): LeadRow | null {
  const row = db()
    .prepare(`
      select l.* from lead_threads t
      join leads l on l.id = t.lead_id
      where t.channel = ? and t.external_id = ? and t.revoked_at is null
    `)
    .get(channel, externalId);
  return plain<LeadRow>(row);
}

/** Throwing variant, for outbound paths where silence would hide a bug. */
export function assertActiveThread(channel: Channel, externalId: string): LeadRow {
  const lead = activeThreadLead(channel, externalId);
  if (!lead) {
    throw new Error(
      `Refusing to touch ${channel} conversation ${externalId}: not an active lead thread.`,
    );
  }
  return lead;
}

/** Allowlisted, unrevoked external ids for a channel — used to filter polls. */
export function activeExternalIds(channel: Channel): Set<string> {
  const rows = db()
    .prepare("select external_id from lead_threads where channel = ? and revoked_at is null")
    .all(channel) as { external_id: string }[];
  return new Set(rows.map((r) => r.external_id));
}

// ─── Messages ────────────────────────────────────────────────────────────────

export interface MessageRow {
  id: number;
  lead_id: number;
  channel: string;
  direction: "inbound" | "outbound";
  body: string | null;
  external_message_id: string | null;
  sent_by: string | null;
  created_at: string;
  /** Null on an outbound message the AI drafted but nobody has relayed yet. */
  sent_at: string | null;
}

/**
 * Append a message. Returns false when the message was already stored — polls
 * overlap and re-fetch, so every write path has to be idempotent.
 */
export function appendMessage(m: {
  leadId: number;
  channel: Channel;
  direction: "inbound" | "outbound";
  body: string;
  externalMessageId?: string | null;
  sentBy: "ai" | "human" | "lead";
  /** Leave false for a draft on a manual channel — nobody has relayed it yet. */
  sent?: boolean;
}): MessageRow | null {
  const sent = m.sent ?? m.direction === "inbound";
  const row = db()
    .prepare(`
      insert into lead_messages (lead_id, channel, direction, body, external_message_id, sent_by, sent_at)
      values (?, ?, ?, ?, ?, ?, ${sent ? "datetime('now')" : "null"})
      on conflict (channel, external_message_id) do nothing
      returning *
    `)
    .get(m.leadId, m.channel, m.direction, m.body, m.externalMessageId ?? null, m.sentBy);

  const inserted = plain<MessageRow>(row);
  if (m.direction === "inbound" && inserted) {
    db()
      .prepare("update leads set last_inbound_at = datetime('now') where id = ?")
      .run(m.leadId);
  }
  return inserted;
}

/** Throw away an unsent draft. Only ever applies to a message nobody relayed. */
export function discardDraft(messageId: number): boolean {
  const r = db()
    .prepare("delete from lead_messages where id = ? and direction = 'outbound' and sent_at is null")
    .run(messageId);
  return Number(r.changes) > 0;
}

export function listMessages(leadId: number): MessageRow[] {
  const rows = db()
    .prepare("select * from lead_messages where lead_id = ? order by created_at asc, id asc")
    .all(leadId);
  return plainAll<MessageRow>(rows);
}

/** The AI's latest draft that still needs relaying by hand, if there is one. */
export function pendingDraft(leadId: number): MessageRow | null {
  const row = db()
    .prepare(`
      select * from lead_messages
      where lead_id = ? and direction = 'outbound' and sent_at is null
      order by id desc limit 1
    `)
    .get(leadId);
  return plain<MessageRow>(row);
}

/**
 * Record that a drafted message was actually relayed. Returns false if it was
 * already marked — double-clicking must not restart the clock.
 */
export function markMessageSent(messageId: number): MessageRow | null {
  const row = db()
    .prepare(
      "update lead_messages set sent_at = datetime('now') where id = ? and sent_at is null returning *",
    )
    .get(messageId);
  return plain<MessageRow>(row);
}

// ─── Conversation state ──────────────────────────────────────────────────────

/** Pin the playbook and character a conversation runs under, once. */
export function assignBrain(leadId: number, playbookId: number, characterId: number): void {
  db()
    .prepare(`
      update leads set playbook_id = coalesce(playbook_id, ?),
                       character_id = coalesce(character_id, ?),
                       updated_at = datetime('now')
      where id = ?
    `)
    .run(playbookId, characterId, leadId);
}

export function saveConversationState(
  leadId: number,
  collected: Record<string, unknown>,
  turnCount: number,
): void {
  db()
    .prepare(
      "update leads set collected = ?, turn_count = ?, last_error = null, updated_at = datetime('now') where id = ?",
    )
    .run(JSON.stringify(collected), turnCount, leadId);
}

export function setDecision(
  leadId: number,
  verdict: "qualified" | "rejected",
  summary: string,
): void {
  db()
    .prepare(
      "update leads set verdict = ?, verdict_summary = ?, updated_at = datetime('now') where id = ?",
    )
    .run(verdict, summary, leadId);
}

export function markFirstOutreach(leadId: number): void {
  db()
    .prepare(
      "update leads set first_outreach_at = coalesce(first_outreach_at, datetime('now')), updated_at = datetime('now') where id = ?",
    )
    .run(leadId);
}

// ─── Human review — the source of the accuracy stat ──────────────────────────

export interface ReviewRow {
  id: number;
  lead_id: number;
  character_id: number | null;
  ai_verdict: string;
  human_verdict: string;
  agreed: number;
  note: string | null;
  reviewed_by: string | null;
  reviewed_at: string;
}

export function getReview(leadId: number): ReviewRow | null {
  const row = db()
    .prepare("select * from decision_reviews where lead_id = ? order by id desc limit 1")
    .get(leadId);
  return plain<ReviewRow>(row);
}

/**
 * Record whether a human agreed with the AI's verdict, and move the lead to its
 * terminal stage. This click is the only source of the accuracy rate — without
 * it the number doesn't exist, which is why it sits on the decision view rather
 * than behind a menu.
 */
export function recordReview(args: {
  leadId: number;
  characterId: number | null;
  aiVerdict: string;
  humanVerdict: "qualified" | "rejected";
  note?: string | null;
  reviewedBy?: string;
}): void {
  db()
    .prepare(`
      insert into decision_reviews (lead_id, character_id, ai_verdict, human_verdict, agreed, note, reviewed_by)
      values (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      args.leadId,
      args.characterId,
      args.aiVerdict,
      args.humanVerdict,
      args.aiVerdict === args.humanVerdict ? 1 : 0,
      args.note?.trim() || null,
      args.reviewedBy ?? "me",
    );
}
