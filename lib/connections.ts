/**
 * Named model connections.
 *
 * Each character points at one, so different characters can run different
 * models — two Ollama models tuned differently, or a hosted model for the
 * character that handles your best leads while a local one handles the rest.
 *
 * The legacy single-provider settings (`llm.*`) still work as a fallback for
 * anyone driving the app from environment variables; see providerConfigFor().
 */

import { db, plain, plainAll } from "./db";
import { currentProviderConfig, PROVIDERS, type ProviderConfig, type ProviderId } from "./llm";

export interface ConnectionRow {
  id: number;
  name: string;
  provider: ProviderId;
  base_url: string;
  api_key: string | null;
  model: string;
  is_default: number;
  created_at: string;
}

export interface ConnectionInput {
  name: string;
  provider: ProviderId;
  baseUrl: string;
  apiKey?: string | null;
  model: string;
}

export function listConnections(): ConnectionRow[] {
  return plainAll<ConnectionRow>(
    db().prepare("select * from model_connections order by is_default desc, id asc").all(),
  );
}

export function getConnection(id: number): ConnectionRow | null {
  return plain<ConnectionRow>(
    db().prepare("select * from model_connections where id = ?").get(id),
  );
}

export function defaultConnection(): ConnectionRow | null {
  return (
    plain<ConnectionRow>(
      db().prepare("select * from model_connections where is_default = 1").get(),
    ) ?? listConnections()[0] ?? null
  );
}

function validate(input: ConnectionInput): void {
  if (!input.name?.trim()) throw new Error("Give the connection a name.");
  if (!input.model?.trim()) throw new Error("Set the model name.");
  if (!PROVIDERS.some((p) => p.id === input.provider)) {
    throw new Error(`Unknown provider "${input.provider}".`);
  }
  if (input.provider !== "ollama" && !input.apiKey?.trim()) {
    throw new Error("That provider needs an API key.");
  }
}

export function createConnection(input: ConnectionInput): number {
  validate(input);
  const first = listConnections().length === 0;
  const fallbackBase = PROVIDERS.find((p) => p.id === input.provider)!.defaultBaseUrl;
  const row = db()
    .prepare(`
      insert into model_connections (name, provider, base_url, api_key, model, is_default)
      values (?, ?, ?, ?, ?, ?) returning id
    `)
    .get(
      input.name.trim(),
      input.provider,
      input.baseUrl?.trim() || fallbackBase,
      input.apiKey?.trim() || null,
      input.model.trim(),
      first ? 1 : 0,
    ) as { id: number };
  return row.id;
}

export function updateConnection(id: number, input: ConnectionInput): void {
  validate(input);
  db()
    .prepare(`
      update model_connections
      set name = ?, provider = ?, base_url = ?, api_key = ?, model = ?
      where id = ?
    `)
    .run(
      input.name.trim(),
      input.provider,
      input.baseUrl.trim(),
      input.apiKey?.trim() || null,
      input.model.trim(),
      id,
    );
}

export function setDefaultConnection(id: number): void {
  const conn = db();
  conn.exec("begin");
  try {
    conn.prepare("update model_connections set is_default = 0").run();
    conn.prepare("update model_connections set is_default = 1 where id = ?").run(id);
    conn.exec("commit");
  } catch (e) {
    conn.exec("rollback");
    throw e;
  }
}

/**
 * Delete a connection. Characters using it fall back to the default rather than
 * breaking, and if the default itself is removed another is promoted — a
 * character must never be left pointing at nothing.
 */
export function deleteConnection(id: number): void {
  const conn = db();
  const wasDefault = getConnection(id)?.is_default === 1;
  conn.exec("begin");
  try {
    conn.prepare("update characters set connection_id = null where connection_id = ?").run(id);
    conn.prepare("delete from model_connections where id = ?").run(id);
    if (wasDefault) {
      const next = conn.prepare("select id from model_connections order by id asc limit 1").get() as
        | { id: number }
        | undefined;
      if (next) conn.prepare("update model_connections set is_default = 1 where id = ?").run(next.id);
    }
    conn.exec("commit");
  } catch (e) {
    conn.exec("rollback");
    throw e;
  }
}

export function toProviderConfig(row: ConnectionRow): ProviderConfig {
  return {
    provider: row.provider,
    baseUrl: row.base_url,
    apiKey: row.api_key ?? undefined,
    model: row.model,
  };
}

/**
 * Resolve which model a character should use: its own connection, else the
 * default, else whatever the legacy `llm.*` settings or env vars say.
 */
export function providerConfigFor(connectionId: number | null): ProviderConfig | null {
  const row = (connectionId ? getConnection(connectionId) : null) ?? defaultConnection();
  if (row) return toProviderConfig(row);
  return currentProviderConfig();
}
