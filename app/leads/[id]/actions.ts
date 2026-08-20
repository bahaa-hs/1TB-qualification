"use server";

import { revalidatePath } from "next/cache";
import {
  advanceConversation,
  confirmSent,
  recordManualReply,
  type StepResult,
} from "@/lib/conversation";
import { claimStage, discardDraft, getLead, recordReview } from "@/lib/leads";

function refresh(leadId: number) {
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/");
  revalidatePath("/stats");
}

export async function draftNextAction(leadId: number): Promise<StepResult> {
  const result = await advanceConversation(leadId);
  refresh(leadId);
  return result;
}

export async function markSentAction(leadId: number, messageId: number): Promise<void> {
  confirmSent(messageId, leadId);
  refresh(leadId);
}

export async function discardDraftAction(leadId: number, messageId: number): Promise<void> {
  discardDraft(messageId);
  refresh(leadId);
}

export async function recordReplyAction(leadId: number, text: string): Promise<StepResult> {
  const result = await recordManualReply(leadId, text);
  refresh(leadId);
  return result;
}

/**
 * The human verdict at Stage 4.
 *
 * Writes the review that the accuracy stat is computed from, then moves the
 * lead to its terminal stage — which revokes the tool's access to the
 * conversation, per the "all access removed once qualification is done"
 * requirement. That revocation happens inside claimStage, so it can't be
 * forgotten here.
 */
export async function reviewDecisionAction(
  leadId: number,
  humanVerdict: "qualified" | "rejected",
  note?: string,
): Promise<void> {
  const lead = getLead(leadId);
  if (!lead) throw new Error("That lead no longer exists.");
  if (!lead.verdict) throw new Error("There's no AI verdict to review yet.");

  recordReview({
    leadId,
    characterId: lead.character_id,
    aiVerdict: lead.verdict,
    humanVerdict,
    note,
  });
  claimStage(leadId, ["decision"], humanVerdict === "qualified" ? "handed_off" : "rejected");
  refresh(leadId);
}
