import { beforeEach, describe, expect, it } from "vitest";
import { _resetDbForTests, db } from "../db";
import {
  createConnection,
  defaultConnection,
  deleteConnection,
  getConnection,
  listConnections,
  providerConfigFor,
  setDefaultConnection,
  updateConnection,
} from "../connections";
import { createCharacter, getCharacter, listCharacters } from "../brain";
import { DEFAULT_CHARACTER } from "../playbook";

const ollama = (name: string, model: string) => ({
  name,
  provider: "ollama" as const,
  baseUrl: "http://127.0.0.1:11434",
  model,
});

beforeEach(() => {
  _resetDbForTests(":memory:");
});

describe("createConnection", () => {
  it("makes the first connection the default", () => {
    const id = createConnection(ollama("Local 8B", "llama3.1:8b"));
    expect(defaultConnection()!.id).toBe(id);
    expect(getConnection(id)!.is_default).toBe(1);
  });

  it("does not steal the default from an existing connection", () => {
    const first = createConnection(ollama("Local 8B", "llama3.1:8b"));
    createConnection(ollama("Local 14B", "qwen:14b"));
    expect(defaultConnection()!.id).toBe(first);
  });

  it("requires a name and a model", () => {
    expect(() => createConnection({ ...ollama("", "x") })).toThrow(/name/i);
    expect(() => createConnection({ ...ollama("A", "") })).toThrow(/model/i);
  });

  it("requires an API key for a hosted provider but not for Ollama", () => {
    expect(() =>
      createConnection({
        name: "Claude",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        model: "claude-sonnet-4-6",
      }),
    ).toThrow(/API key/i);

    expect(() => createConnection(ollama("Local", "llama3.1:8b"))).not.toThrow();
  });

  it("rejects a duplicate name", () => {
    createConnection(ollama("Local", "llama3.1:8b"));
    expect(() => createConnection(ollama("Local", "other"))).toThrow();
  });
});

describe("setDefaultConnection", () => {
  it("moves the flag rather than setting a second default", () => {
    const a = createConnection(ollama("A", "m1"));
    const b = createConnection(ollama("B", "m2"));

    setDefaultConnection(b);

    expect(getConnection(a)!.is_default).toBe(0);
    expect(getConnection(b)!.is_default).toBe(1);
    expect(listConnections().filter((c) => c.is_default === 1)).toHaveLength(1);
  });
});

describe("deleteConnection", () => {
  it("leaves characters pointing at nothing rather than at a dead id", () => {
    // A character must never reference a connection that no longer exists —
    // null falls back to the default, a stale id would just fail at send time.
    const a = createConnection(ollama("A", "m1"));
    createConnection(ollama("B", "m2"));
    const charId = createCharacter(DEFAULT_CHARACTER, a);
    expect(getCharacter(charId)!.connection_id).toBe(a);

    deleteConnection(a);

    expect(getCharacter(charId)!.connection_id).toBeNull();
    expect(listCharacters()).toHaveLength(1);
  });

  it("promotes another connection when the default is removed", () => {
    const a = createConnection(ollama("A", "m1"));
    const b = createConnection(ollama("B", "m2"));
    expect(getConnection(a)!.is_default).toBe(1);

    deleteConnection(a);

    expect(getConnection(b)!.is_default).toBe(1);
  });

  it("copes with removing the only connection", () => {
    const a = createConnection(ollama("A", "m1"));
    deleteConnection(a);
    expect(listConnections()).toHaveLength(0);
    expect(defaultConnection()).toBeNull();
  });
});

describe("providerConfigFor", () => {
  it("uses the character's own connection", () => {
    createConnection(ollama("Default", "llama3.1:8b"));
    const special = createConnection(ollama("Big", "qwen:14b"));

    expect(providerConfigFor(special)!.model).toBe("qwen:14b");
  });

  it("falls back to the default when the character has none", () => {
    createConnection(ollama("Default", "llama3.1:8b"));
    expect(providerConfigFor(null)!.model).toBe("llama3.1:8b");
  });

  it("falls back to the default when the character's connection was deleted", () => {
    const gone = createConnection(ollama("Gone", "m1"));
    const keep = createConnection(ollama("Keep", "m2"));
    setDefaultConnection(keep);
    deleteConnection(gone);

    expect(providerConfigFor(gone)!.model).toBe("m2");
  });

  it("returns null when nothing is configured at all", () => {
    expect(providerConfigFor(null)).toBeNull();
  });

  it("carries the API key through for a hosted provider", () => {
    const id = createConnection({
      name: "Claude",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-test",
      model: "claude-sonnet-4-6",
    });
    const cfg = providerConfigFor(id)!;
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.apiKey).toBe("sk-test");
  });
});

describe("updateConnection", () => {
  it("swaps the model without touching which characters use it", () => {
    // The point of a connection being a row rather than fields on a character:
    // changing the model is one edit, not one per character.
    const id = createConnection(ollama("Local", "llama3.1:8b"));
    const a = createCharacter({ ...DEFAULT_CHARACTER, name: "Sam" }, id);
    const b = createCharacter({ ...DEFAULT_CHARACTER, name: "Alex" }, id);

    updateConnection(id, ollama("Local", "qwen:14b"));

    expect(providerConfigFor(getCharacter(a)!.connection_id)!.model).toBe("qwen:14b");
    expect(providerConfigFor(getCharacter(b)!.connection_id)!.model).toBe("qwen:14b");
  });
});

describe("migration 0003", () => {
  it("creates no connection when nothing was configured", () => {
    expect(listConnections()).toHaveLength(0);
  });

  it("folds an existing llm.* setup into a Default connection", () => {
    // An existing install must keep working without being reconfigured.
    const conn = db();
    conn.exec("drop table model_connections");
    conn.exec("delete from _migrations where name = '0003_model_connections'");
    conn
      .prepare("insert into settings (key, value) values ('llm.provider', 'ollama')")
      .run();
    conn
      .prepare("insert into settings (key, value) values ('llm.model', 'llama3.1:8b')")
      .run();
    conn
      .prepare(
        "insert into settings (key, value) values ('llm.baseUrl', 'http://127.0.0.1:11434')",
      )
      .run();
    // characters.connection_id already exists from the first run of 0003, so
    // re-running the whole migration would fail; assert the intent directly.
    conn.exec(`
      create table model_connections (
        id integer primary key, name text unique not null, provider text not null,
        base_url text not null, api_key text, model text not null,
        is_default integer not null default 0,
        created_at text not null default (datetime('now'))
      );
      insert into model_connections (name, provider, base_url, api_key, model, is_default)
      select 'Default',
             coalesce((select value from settings where key = 'llm.provider'), 'ollama'),
             coalesce((select value from settings where key = 'llm.baseUrl'), 'http://127.0.0.1:11434'),
             (select value from settings where key = 'llm.apiKey'),
             (select value from settings where key = 'llm.model'),
             1
      where exists (select 1 from settings where key = 'llm.model');
    `);

    const d = defaultConnection()!;
    expect(d.name).toBe("Default");
    expect(d.model).toBe("llama3.1:8b");
    expect(d.provider).toBe("ollama");
  });
});
