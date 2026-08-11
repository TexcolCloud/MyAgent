import { describe, expect, it, vi } from "vitest";

import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "../../src/adapters/sqlite/database.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { tempPath } from "../helpers/temp-dir.js";

const NOW = "2026-08-09T00:00:00.000Z";

describe("SQLite migrations", () => {
  it("migrates an empty database and reopens it with required pragmas", () => {
    const file = tempPath("kernel.db");
    const first = openDatabase({ path: file, busyTimeoutMs: 5_000 });
    try {
      migrate(first.db);
      expect(first.db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(first.db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(first.db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5_000 });
      expect(first.db.prepare(
        `SELECT name FROM sqlite_master
         WHERE name IN ('outbox_deliveries', 'outbox_deliveries_pending')`,
      ).all()).toEqual([]);
    } finally {
      first.close();
    }

    const reopened = openDatabase({ path: file, busyTimeoutMs: 5_000 });
    try {
      migrate(reopened.db);
      expect(reopened.db.prepare("SELECT version FROM schema_migrations").all()).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
      ]);
    } finally {
      reopened.close();
    }
  });

  it("rechecks migration history after acquiring the write lock", () => {
    const file = tempPath("concurrent-migration.db");
    const first = openDatabase({ path: file, busyTimeoutMs: 5_000 });
    const second = openDatabase({ path: file, busyTimeoutMs: 5_000 });
    try {
      const interleaved = beforeFirstBegin(first.db, () => migrate(second.db));

      expect(() => migrate(interleaved)).not.toThrow();
      expect(first.db.prepare("SELECT version FROM schema_migrations").all()).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
      ]);
    } finally {
      second.close();
      first.close();
    }
  });

  it("backfills Provider Drivers when upgrading a version 2 registry", () => {
    const connection = openDatabase({
      path: tempPath("pi-runtime-upgrade.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrateThroughVersion2(connection.db);
      const insert = connection.db.prepare(
        `INSERT INTO provider_connections (
           connection_id, display_name, provider_kind, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?)`,
      );
      insert.run("legacy-openai", "OpenAI", "openai", NOW, NOW);
      insert.run("legacy-deepseek", "DeepSeek", "deepseek", NOW, NOW);
      insert.run("legacy-compatible", "Compatible", "openai_compatible", NOW, NOW);

      migrate(connection.db);

      expect(connection.db.prepare(
        `SELECT connection_id, provider_driver FROM provider_connections
         ORDER BY connection_id`,
      ).all()).toEqual([
        { connection_id: "legacy-compatible", provider_driver: "pi/openai-compatible" },
        { connection_id: "legacy-deepseek", provider_driver: "pi/deepseek" },
        { connection_id: "legacy-openai", provider_driver: "pi/openai" },
      ]);
    } finally {
      connection.close();
    }
  });

  it("rejects a message linked to a Run from another Session", () => {
    const connection = openDatabase({
      path: tempPath("message-ownership.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      seedRevision(connection.db);
      seedSession(connection.db, "session-a", "session:a");
      seedSession(connection.db, "session-b", "session:b");
      seedRun(connection.db, "run-a", "session-a");

      expect(() =>
        connection.db
          .prepare(
            `INSERT INTO messages (
              message_id, session_id, run_id, sequence, run_fifo_sequence,
              role, content_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "message-b",
            "session-b",
            "run-a",
            0,
            0,
            "user",
            "{}",
            "2026-08-07T00:00:00.000Z",
          ),
      ).toThrow();
    } finally {
      connection.close();
    }
  });

  it("rejects an Approval linked to a Tool Call from another Run", () => {
    const connection = openDatabase({
      path: tempPath("approval-ownership.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      seedRevision(connection.db);
      seedSession(connection.db, "session-a", "session:a");
      seedSession(connection.db, "session-b", "session:b");
      seedRun(connection.db, "run-a", "session-a");
      seedRun(connection.db, "run-b", "session-b");
      seedToolCall(connection.db, "tool-call-a", "run-a");

      expect(() =>
        connection.db
          .prepare(
            `INSERT INTO approvals (
              approval_id, run_id, tool_call_id, state, arguments_sha256,
              expires_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "approval-b",
            "run-b",
            "tool-call-a",
            "pending",
            "arguments-digest",
            "2026-08-07T00:05:00.000Z",
            "2026-08-07T00:00:00.000Z",
          ),
      ).toThrow();
    } finally {
      connection.close();
    }
  });

  it("rejects an idempotency key scoped to a different Session than its Run", () => {
    const connection = openDatabase({
      path: tempPath("idempotency-ownership.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      seedRevision(connection.db);
      seedSession(connection.db, "session-a", "session:a");
      seedSession(connection.db, "session-b", "session:b");
      seedRun(connection.db, "run-a", "session-a");

      expect(() =>
        connection.db
          .prepare(
            `INSERT INTO idempotency_keys (
              agent_id, session_key, key, request_digest, run_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "primary",
            "session:b",
            "request-0001",
            "request-digest",
            "run-a",
            "2026-08-07T00:00:00.000Z",
          ),
      ).toThrow();
    } finally {
      connection.close();
    }
  });

  it("rejects a current Summary owned by another Session", () => {
    const connection = openDatabase({
      path: tempPath("summary-ownership.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      seedRevision(connection.db);
      seedSession(connection.db, "session-a", "session:a");
      seedSession(connection.db, "session-b", "session:b");
      connection.db
        .prepare(
          `INSERT INTO session_summaries (
            summary_id, session_id, from_message_sequence, to_message_sequence,
            content, model_provider, model_name, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "summary-a",
          "session-a",
          0,
          0,
          "summary",
          "openai",
          "gpt-5",
          "2026-08-07T00:00:00.000Z",
        );

      expect(() =>
        connection.db
          .prepare("UPDATE sessions SET current_summary_id = ? WHERE session_id = ?")
          .run("summary-a", "session-b"),
      ).toThrow();
    } finally {
      connection.close();
    }
  });

  it("rejects unknown persisted state strings", () => {
    const connection = openDatabase({
      path: tempPath("state-checks.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      seedRevision(connection.db);
      seedSession(connection.db, "session-a", "session:a");

      expect(() => seedRun(connection.db, "run-a", "session-a", "not-a-state"))
        .toThrow();
    } finally {
      connection.close();
    }
  });

  it("keeps canonical Tool arguments and digests immutable", () => {
    const connection = openDatabase({
      path: tempPath("tool-call-immutability.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      seedRevision(connection.db);
      seedSession(connection.db, "session-a", "session:a");
      seedRun(connection.db, "run-a", "session-a");
      seedToolCall(connection.db, "tool-call-a", "run-a");

      expect(() =>
        connection.db
          .prepare("UPDATE tool_calls SET arguments_sha256 = ? WHERE tool_call_id = ?")
          .run("different-digest", "tool-call-a"),
      ).toThrowError("immutable_tool_call_arguments");
    } finally {
      connection.close();
    }
  });

  it("creates the final model registry schema with every owned table", () => {
    const connection = openDatabase({
      path: tempPath("model-registry-schema.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);

      expect(connection.db.prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'provider_connections', 'provider_connection_revisions',
           'model_profiles', 'model_profile_revisions', 'model_assignments',
           'default_model_profile', 'model_registry_events',
           'discovery_generations', 'discovered_models', 'model_verifications',
           'provider_health', 'managed_secret_versions',
           'managed_secret_keyring', 'legacy_model_imports'
         ) ORDER BY name`,
      ).all()).toEqual([
        { name: "default_model_profile" },
        { name: "discovered_models" },
        { name: "discovery_generations" },
        { name: "legacy_model_imports" },
        { name: "managed_secret_keyring" },
        { name: "managed_secret_versions" },
        { name: "model_assignments" },
        { name: "model_profile_revisions" },
        { name: "model_profiles" },
        { name: "model_registry_events" },
        { name: "model_verifications" },
        { name: "provider_connection_revisions" },
        { name: "provider_connections" },
        { name: "provider_health" },
      ]);
      expect(connection.db.prepare("PRAGMA table_info(tool_calls)").all())
        .toContainEqual(expect.objectContaining({ name: "provider_call_id", notnull: 0 }));
      expect(connection.db.prepare("PRAGMA table_info(provider_connections)").all())
        .toContainEqual(expect.objectContaining({ name: "provider_driver", notnull: 0 }));
      expect(connection.db.prepare("PRAGMA table_info(model_profile_revisions)").all())
        .toContainEqual(expect.objectContaining({ name: "runtime_contract_json", notnull: 0 }));
      for (const table of [
        "provider_connections",
        "model_profiles",
        "model_assignments",
        "default_model_profile",
        "discovery_generations",
        "model_verifications",
        "provider_health",
        "managed_secret_versions",
        "managed_secret_keyring",
      ]) {
        expect(connection.db.prepare(`PRAGMA table_info(${table})`).all())
          .toContainEqual(expect.objectContaining({ name: "record_revision", notnull: 1 }));
      }
    } finally {
      connection.close();
    }
  });

  it("enforces singleton keyring, immutable revisions, append-only audit, and provider call identity", () => {
    const connection = openDatabase({
      path: tempPath("model-registry-constraints.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      connection.db.prepare(
        `INSERT INTO provider_connections (
           connection_id, display_name, provider_kind, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?)`,
      ).run("connection-a", "Connection A", "openai", NOW, NOW);
      connection.db.prepare(
        `INSERT INTO provider_connection_revisions (
           revision_id, connection_id, state, base_url, auth_json,
           allow_insecure_http, protocol_preference, preset_version, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "pcr-a", "connection-a", "draft", "https://api.example.test/v1",
        '{"type":"none"}', 0, "responses", "2026-08-09", NOW,
      );
      connection.db.prepare(
        `INSERT INTO model_profiles (
           profile_id, display_name, created_at, updated_at
         ) VALUES (?, ?, ?, ?)`,
      ).run("profile-a", "Profile A", NOW, NOW);
      connection.db.prepare(
        `INSERT INTO model_profile_revisions (
           revision_id, profile_id, connection_revision_id, state,
           provider_model_id, invocation_protocol, max_input_tokens,
           context_window_source, capability_baseline,
           verified_capabilities_json, runtime_contract_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "mpr-a", "profile-a", "pcr-a", "draft", "claude-test", "responses",
        200_000, "preset", "text_and_single_tool_call_v1", "[]",
        '{"kind":"pi_ai","piVersion":"0.73.1"}', NOW,
      );
      connection.db.prepare(
        `INSERT INTO model_registry_events (
           event_id, resource_type, resource_id, action, payload_json,
           trace_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("event-a", "provider_connection", "connection-a", "created", "{}", "trace-a", NOW);
      connection.db.prepare(
        `INSERT INTO managed_secret_keyring (
           singleton_id, current_key_id, record_revision, updated_at
         ) VALUES (?, ?, ?, ?)`,
      ).run(1, "key-a", 0, NOW);

      expect(() => connection.db.prepare(
        "UPDATE provider_connection_revisions SET base_url = ? WHERE revision_id = ?",
      ).run("https://changed.example.test/v1", "pcr-a"))
        .toThrowError("immutable_provider_connection_revision");
      expect(() => connection.db.prepare(
        "UPDATE model_profile_revisions SET runtime_contract_json = ? WHERE revision_id = ?",
      ).run('{"kind":"changed"}', "mpr-a"))
        .toThrowError("immutable_model_profile_revision");
      expect(() => connection.db.prepare(
        "UPDATE provider_connections SET provider_driver = ? WHERE connection_id = ?",
      ).run("pi/deepseek", "connection-a"))
        .toThrowError("immutable_provider_driver");
      expect(() => connection.db.prepare(
        "DELETE FROM model_registry_events WHERE event_id = ?",
      ).run("event-a")).toThrowError("append_only_model_registry_events");
      expect(() => connection.db.prepare(
        `INSERT INTO managed_secret_keyring (
           singleton_id, current_key_id, record_revision, updated_at
         ) VALUES (?, ?, ?, ?)`,
      ).run(2, "key-b", 0, NOW)).toThrow();

      seedRevision(connection.db);
      seedSession(connection.db, "session-a", "session:a");
      seedRun(connection.db, "run-a", "session-a");
      seedToolCall(connection.db, "tool-call-a", "run-a");
      connection.db.prepare(
        "UPDATE tool_calls SET provider_call_id = ? WHERE tool_call_id = ?",
      ).run("provider-call-a", "tool-call-a");
      expect(() => connection.db.prepare(
        "UPDATE tool_calls SET provider_call_id = ? WHERE tool_call_id = ?",
      ).run("provider-call-b", "tool-call-a"))
        .toThrowError("immutable_provider_call_id");
    } finally {
      connection.close();
    }
  });

  it("cascades deletion from a root Session through delegated Sessions", () => {
    const connection = openDatabase({
      path: tempPath("session-cascade.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      seedRevision(connection.db);
      seedSession(connection.db, "session-root", "session:root");
      seedSession(connection.db, "session-child", "session:child", "session-root");
      seedRun(connection.db, "run-child", "session-child");

      connection.db.prepare("DELETE FROM sessions WHERE session_id = ?").run("session-root");

      expect(connection.db.prepare("SELECT session_id FROM sessions").all()).toEqual([]);
      expect(connection.db.prepare("SELECT run_id FROM runs").all()).toEqual([]);
    } finally {
      connection.close();
    }
  });

  it("rolls back both schema changes and version recording on migration failure", () => {
    const connection = openDatabase({
      path: tempPath("migration-rollback.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      connection.db.exec("CREATE TABLE runs (run_id TEXT PRIMARY KEY)");

      expect(() => migrate(connection.db)).toThrowError("table runs already exists");
      expect(connection.db.prepare("SELECT version FROM schema_migrations").all()).toEqual([]);
      expect(
        connection.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get("agent_revisions"),
      ).toBeUndefined();
    } finally {
      connection.close();
    }
  });

  it("rejects a database version newer than the binary", () => {
    const connection = openDatabase({
      path: tempPath("newer-database.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      connection.db
        .prepare(
          "INSERT INTO schema_migrations (version, applied_at) VALUES (?, datetime('now'))",
        )
        .run(4);

      expect(() => migrate(connection.db)).toThrowError("database_newer_than_binary");
    } finally {
      connection.close();
    }
  });

  it("rejects an applied migration history that is not a strict prefix", async () => {
    const migrateWithTwoVersions = await importMigratorWithResources({
      "0001-first.sql": "CREATE TABLE migration_one (id INTEGER PRIMARY KEY)",
      "0002-second.sql": "CREATE TABLE migration_two (id INTEGER PRIMARY KEY)",
    });
    const connection = openDatabase({
      path: tempPath("migration-gap.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      connection.db.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY CHECK (version > 0),
          applied_at TEXT NOT NULL
        )
      `);
      connection.db
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(2, "2026-08-07T00:00:00.000Z");

      expect(() => migrateWithTwoVersions(connection.db)).toThrowError(
        "inconsistent_migration_history",
      );
    } finally {
      connection.close();
      restoreMigrationResourceMock();
    }
  });

  it("applies migration resources in numeric order", async () => {
    const migrateOutOfDirectoryOrder = await importMigratorWithResources({
      "0002-second.sql": "INSERT INTO migration_order (step) VALUES (2)",
      "0001-first.sql":
        "CREATE TABLE migration_order (step INTEGER NOT NULL); " +
        "INSERT INTO migration_order (step) VALUES (1)",
    });
    const connection = openDatabase({
      path: tempPath("migration-order.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrateOutOfDirectoryOrder(connection.db);

      expect(connection.db.prepare("SELECT step FROM migration_order").all()).toEqual([
        { step: 1 },
        { step: 2 },
      ]);
      expect(connection.db.prepare("SELECT version FROM schema_migrations").all()).toEqual([
        { version: 1 },
        { version: 2 },
      ]);
    } finally {
      connection.close();
      restoreMigrationResourceMock();
    }
  });

  it("allows only one blocking Run per Session", () => {
    const connection = openDatabase({
      path: tempPath("blocking-run.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      seedRevision(connection.db);
      seedSession(connection.db, "session-a", "session:a");
      seedRun(connection.db, "run-a", "session-a", "running", 0);
      seedRun(connection.db, "run-b", "session-a", "queued", 1);

      expect(() =>
        connection.db
          .prepare("UPDATE runs SET state = ? WHERE run_id = ?")
          .run("waiting_approval", "run-b"),
      ).toThrow();
    } finally {
      connection.close();
    }
  });

  it("rejects duplicate event sequences within one Run", () => {
    const connection = openDatabase({
      path: tempPath("event-sequence.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      seedRevision(connection.db);
      seedSession(connection.db, "session-a", "session:a");
      seedRun(connection.db, "run-a", "session-a");
      insertRunEvent(connection.db, "event-a", "run-a", 1);

      expect(() => insertRunEvent(connection.db, "event-b", "run-a", 1)).toThrow();
    } finally {
      connection.close();
    }
  });
});

async function importMigratorWithResources(
  resources: Readonly<Record<string, string>>,
): Promise<typeof migrate> {
  vi.resetModules();
  vi.doMock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
      ...actual,
      readdirSync: () => Object.keys(resources),
      readFileSync: (file: string | URL) => {
        const name = file.toString().split(/[\\/]/).at(-1) ?? "";
        const sql = resources[name];
        if (sql === undefined) {
          throw new Error(`missing test migration: ${name}`);
        }
        return sql;
      },
    };
  });

  return (await import("../../src/adapters/sqlite/migrator.js")).migrate;
}

function restoreMigrationResourceMock(): void {
  vi.doUnmock("node:fs");
  vi.resetModules();
}

function migrateThroughVersion2(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      applied_at TEXT NOT NULL
    )
  `);
  for (const version of [1, 2]) {
    const sql = readFileSync(new URL(
      `../../src/adapters/sqlite/migrations/${String(version).padStart(4, "0")}-${
        version === 1 ? "m1-kernel" : "model-registry"
      }.sql`,
      import.meta.url,
    ), "utf8");
    db.exec(sql);
    db.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    ).run(version, NOW);
  }
}

function beforeFirstBegin(db: DatabaseSync, callback: () => void): DatabaseSync {
  let pending = true;
  return new Proxy(db, {
    get(target, property) {
      if (property === "exec") {
        return (sql: string): void => {
          if (pending && sql.trim() === "BEGIN IMMEDIATE") {
            pending = false;
            callback();
          }
          target.exec(sql);
        };
      }

      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function seedRevision(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO agent_revisions (
      revision_id, agent_id, content_json, content_sha256, created_at
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "revision-primary",
    "primary",
    "{}",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "2026-08-07T00:00:00.000Z",
  );
}

function seedSession(
  db: DatabaseSync,
  sessionId: string,
  sessionKey: string,
  ownerSessionId: string | null = null,
): void {
  db.prepare(
    `INSERT INTO sessions (
      session_id, agent_id, session_key, agent_revision_id, owner_session_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    "primary",
    sessionKey,
    "revision-primary",
    ownerSessionId,
    "2026-08-07T00:00:00.000Z",
    "2026-08-07T00:00:00.000Z",
  );
}

function seedRun(
  db: DatabaseSync,
  runId: string,
  sessionId: string,
  state = "queued",
  fifoSequence = 0,
): void {
  db.prepare(
    `INSERT INTO runs (
      run_id, session_id, agent_revision_id, state, fifo_sequence,
      delegation_depth, request_digest, input_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    sessionId,
    "revision-primary",
    state,
    fifoSequence,
    0,
    "request-digest",
    "{}",
    "2026-08-07T00:00:00.000Z",
    "2026-08-07T00:00:00.000Z",
  );
}

function seedToolCall(db: DatabaseSync, toolCallId: string, runId: string): void {
  db.prepare(
    `INSERT INTO tool_calls (
      tool_call_id, run_id, state, tool_name, effect, arguments_json,
      canonical_arguments, arguments_sha256, policy_effect, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    toolCallId,
    runId,
    "waiting_approval",
    "read_file",
    "read_only",
    "{}",
    "{}",
    "arguments-digest",
    "ask",
    "2026-08-07T00:00:00.000Z",
    "2026-08-07T00:00:00.000Z",
  );
}

function insertRunEvent(
  db: DatabaseSync,
  eventId: string,
  runId: string,
  sequence: number,
): void {
  db.prepare(
    `INSERT INTO run_events (
      event_id, run_id, sequence, event_type, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId,
    runId,
    sequence,
    "run.queued",
    "{}",
    "2026-08-07T00:00:00.000Z",
  );
}
