/**
 * Settings.
 *
 * Values live in the `settings` table because teammates configure this in the
 * app, not in a text file. An environment variable of the mapped name still
 * wins — that keeps the `leads AI` / `word frequency` convention available as
 * an escape hatch for anyone who prefers it, without making it the only path.
 */

import { db } from "./db";
import { env } from "./env";

export const SETTING_KEYS = {
  llmProvider: "llm.provider",
  llmBaseUrl: "llm.baseUrl",
  llmApiKey: "llm.apiKey",
  llmModel: "llm.model",
  heyreachApiKey: "heyreach.apiKey",
  heyreachCampaignId: "heyreach.campaignId",
  heyreachAccountId: "heyreach.linkedInAccountId",
  telegramBotToken: "telegram.botToken",
  defaultPlaybookId: "brain.defaultPlaybookId",
  defaultCharacterId: "brain.defaultCharacterId",
  // The general instruction layer governing every character. See lib/prompt.ts.
  promptIdentity: "prompt.identity",
  promptKnowledge: "prompt.knowledge",
  promptRules: "prompt.rules",
  promptOpening: "prompt.opening",
  promptNeverSay: "prompt.neverSay",
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

/** Env var that overrides each setting, for whoever wants to use one. */
const ENV_OVERRIDE: Partial<Record<SettingKey, string>> = {
  "llm.provider": "LLM_PROVIDER",
  "llm.baseUrl": "LLM_BASE_URL",
  "llm.apiKey": "LLM_API_KEY",
  "llm.model": "LLM_MODEL",
  "heyreach.apiKey": "HEYREACH_API_KEY",
  "heyreach.campaignId": "HEYREACH_CAMPAIGN_ID",
  "heyreach.linkedInAccountId": "HEYREACH_LINKEDIN_ACCOUNT_ID",
  "telegram.botToken": "TELEGRAM_BOT_TOKEN",
};

export function getSetting(key: SettingKey): string | undefined {
  const fromEnv = ENV_OVERRIDE[key] ? env(ENV_OVERRIDE[key]!) : undefined;
  if (fromEnv) return fromEnv;
  const row = db().prepare("select value from settings where key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value?.trim() || undefined;
}

export function setSetting(key: SettingKey, value: string | null): void {
  if (value === null || value.trim() === "") {
    db().prepare("delete from settings where key = ?").run(key);
    return;
  }
  db()
    .prepare(
      `insert into settings (key, value) values (?, ?)
       on conflict (key) do update set value = excluded.value, updated_at = datetime('now')`,
    )
    .run(key, value.trim());
}

/** True when the setting is pinned by the environment and can't be edited here. */
export function isEnvPinned(key: SettingKey): boolean {
  return Boolean(ENV_OVERRIDE[key] && env(ENV_OVERRIDE[key]!));
}
