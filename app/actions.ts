"use server";

/**
 * Server actions for the mutations the UI performs.
 *
 * Deliberately using server actions rather than the API routes the plan
 * sketched: this is a single-user local app with no external callers, so a
 * route handler per mutation would be ceremony with no payoff. Real API routes
 * still get built where something outside the browser calls in — the Gmail
 * OAuth callback in Phase 4.
 */

import { revalidatePath } from "next/cache";
import { parseFilloutCsv } from "@/lib/csv";
import type { Channel } from "@/lib/csv";
import {
  disableAllAi,
  importLeads,
  setAiEnabled,
  updateContact,
  type ImportSummary,
} from "@/lib/leads";

export async function importCsvAction(formData: FormData): Promise<ImportSummary> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("Choose a CSV file to upload.");
  }
  const text = await file.text();
  const parsed = parseFilloutCsv(text);
  if (parsed.leads.length === 0) {
    throw new Error(
      `No leads found in ${file.name}. ${parsed.skipped} row(s) had no Submission ID — is this a Fillout export?`,
    );
  }
  const summary = importLeads(file.name, parsed.leads, parsed.skipped);
  revalidatePath("/");
  revalidatePath("/import");
  return summary;
}

export async function updateContactAction(
  leadId: number,
  edit: {
    email?: string | null;
    whatsappE164?: string | null;
    telegramHandle?: string | null;
    linkedinUrl?: string | null;
    companyWebsite?: string | null;
    preferredChannel?: Channel | null;
  },
): Promise<void> {
  updateContact(leadId, edit, "me");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/");
}

export async function setAiEnabledAction(leadId: number, enabled: boolean): Promise<void> {
  setAiEnabled(leadId, enabled);
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/");
}

export async function disableAllAiAction(): Promise<number> {
  const n = disableAllAi();
  revalidatePath("/");
  return n;
}
