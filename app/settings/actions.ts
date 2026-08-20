"use server";

import { revalidatePath } from "next/cache";
import { setSetting } from "@/lib/config";
import { testProvider, type ProviderConfig, type ProviderId, type TestResult } from "@/lib/llm";
import {
  createConnection,
  deleteConnection,
  setDefaultConnection,
  updateConnection,
  type ConnectionInput,
} from "@/lib/connections";

function refresh() {
  revalidatePath("/settings");
  revalidatePath("/brain");
}

// ─── Model connections ───────────────────────────────────────────────────────

export async function saveConnectionAction(
  id: number | null,
  input: ConnectionInput,
): Promise<number> {
  if (id === null) {
    const newId = createConnection(input);
    refresh();
    return newId;
  }
  updateConnection(id, input);
  refresh();
  return id;
}

export async function deleteConnectionAction(id: number): Promise<void> {
  deleteConnection(id);
  refresh();
}

export async function setDefaultConnectionAction(id: number): Promise<void> {
  setDefaultConnection(id);
  refresh();
}

/**
 * Test without saving, so a bad configuration can be diagnosed and fixed before
 * it becomes the thing a character uses.
 */
export async function testProviderAction(config: ProviderConfig): Promise<TestResult> {
  return testProvider(config);
}

// ─── Optional channel credentials ────────────────────────────────────────────

export async function saveIntegrationsAction(v: {
  heyreachApiKey: string;
  heyreachCampaignId: string;
  heyreachAccountId: string;
  telegramBotToken: string;
}): Promise<void> {
  setSetting("heyreach.apiKey", v.heyreachApiKey);
  setSetting("heyreach.campaignId", v.heyreachCampaignId);
  setSetting("heyreach.linkedInAccountId", v.heyreachAccountId);
  setSetting("telegram.botToken", v.telegramBotToken);
  refresh();
}

export type { ProviderId };
