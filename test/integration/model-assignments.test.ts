import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  openDatabase,
  withImmediateTransaction,
} from "../../src/adapters/sqlite/database.js";
import { SqliteEncryptedSecretStore } from "../../src/adapters/sqlite/encrypted-secret-store.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { SqliteModelRegistryRepository } from "../../src/adapters/sqlite/model-registry-repository.js";
import { AssignModelService } from "../../src/application/assign-model.js";
import { ManageProviderConnectionsService } from "../../src/application/manage-provider-connections.js";
import { ManageSecretsService } from "../../src/application/manage-secrets.js";
import {
  parseAgentId,
  type ManagedSecretVersionId,
  type ModelProfileId,
  type ModelProfileRevisionId,
  type ModelRegistryEventId,
  type ProviderConnectionId,
  type ProviderConnectionRevisionId,
} from "../../src/domain/ids.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { FakeIds } from "../helpers/fake-ids.js";
import { tempPath } from "../helpers/temp-dir.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");

describe("AssignModelService", () => {
  it("snapshots the current default only when an Agent is first synchronized", () => {
    usingFixture("assignment-first-seen", ({ db, repository }) => {
      seedActiveProfiles(db);
      const service = assignments(repository, [
        "mre_default_old",
        "mre_sync_primary",
        "mre_default_new",
        "mre_sync_existing",
        "mre_sync_researcher",
      ]);

      service.setDefault({
        profileId: "assistant" as ModelProfileId,
        expectedRevision: 0,
        traceId: "default-old",
      });
      service.synchronizeAgents([parseAgentId("primary")]);
      service.setDefault({
        profileId: "research" as ModelProfileId,
        expectedRevision: 0,
        traceId: "default-new",
      });
      expect(service.synchronizeAgents([parseAgentId("primary")])).toEqual([]);
      service.synchronizeAgents([parseAgentId("researcher")]);

      expect(repository.getAssignment(parseAgentId("primary"))).toMatchObject({
        modelProfileRevisionId: "mpr_old",
        source: "default",
        recordRevision: 0,
      });
      expect(repository.getAssignment(parseAgentId("researcher"))).toMatchObject({
        modelProfileRevisionId: "mpr_new",
        source: "default",
        recordRevision: 0,
      });
    });
  });

  it("leaves first-seen Agents unassigned when no default exists", () => {
    usingFixture("assignment-no-default", ({ repository }) => {
      const service = assignments(repository, ["mre_sync_unassigned"]);

      expect(service.synchronizeAgents([parseAgentId("primary")])).toEqual([]);
      expect(repository.getAssignment(parseAgentId("primary"))).toBeNull();
    });
  });

  it("accepts only the exact active verified revision for an explicit assignment", () => {
    usingFixture("assignment-exact-active", ({ db, repository }) => {
      seedActiveProfiles(db);
      seedProfileRevision(db, {
        profileId: "assistant",
        revisionId: "mpr_stale",
        state: "superseded",
      });
      const service = assignments(repository, ["mre_stale", "mre_active"]);

      expect(() => service.assign({
        agentId: parseAgentId("primary"),
        profileRevisionId: "mpr_stale" as ModelProfileRevisionId,
        expectedRevision: 0,
        traceId: "assign-stale",
      })).toThrowError(expect.objectContaining({ code: "verification_required" }));
      expect(service.assign({
        agentId: parseAgentId("primary"),
        profileRevisionId: "mpr_old" as ModelProfileRevisionId,
        expectedRevision: 0,
        traceId: "assign-active",
      })).toMatchObject({
        agentId: "primary",
        modelProfileRevisionId: "mpr_old",
        source: "explicit",
      });
    });
  });
});

describe("ManageProviderConnectionsService", () => {
  it("rejects no-auth OpenAI presets without creating registry state", () => {
    usingFixture("connection-required-auth", ({ db, repository }) => {
      const service = new ManageProviderConnectionsService(
        repository,
        { createProviderApiKey: () => { throw new Error("must_not_create_secret"); } },
        new FakeClock(NOW),
        new FakeIds({
          providerConnectionRevisionIds: [
            "pcr_invalid_auth" as ProviderConnectionRevisionId,
          ],
          modelRegistryEventIds: [
            "mre_invalid_auth" as ModelRegistryEventId,
          ],
        }),
        transaction(db),
      );

      expect(() => service.create({
        connectionId: "provider-no-auth" as ProviderConnectionId,
        displayName: "Provider No Auth",
        providerKind: "openai",
        credential: { type: "none" },
        traceId: "connection-no-auth",
      })).toThrowError(expect.objectContaining({
        code: "invalid_provider_connection",
      }));
      expect(tableCount(db, "provider_connections")).toBe(0);
      expect(tableCount(db, "provider_connection_revisions")).toBe(0);
    });
  });

  it("preserves the base revision preset provenance when creating a draft", () => {
    usingFixture("connection-preset-provenance", ({ db, repository }) => {
      db.prepare(
        `INSERT INTO provider_connections (
           connection_id, display_name, provider_kind, active_revision_id,
           record_revision, created_at, updated_at
         ) VALUES ('provider-historical', 'Historical Provider', 'openai',
           NULL, 0, ?, ?)`,
      ).run(NOW.toISOString(), NOW.toISOString());
      db.prepare(
        `INSERT INTO provider_connection_revisions (
           revision_id, connection_id, state, base_url, auth_json,
           allow_insecure_http, protocol_preference, preset_version, created_at
         ) VALUES ('pcr_historical', 'provider-historical', 'active',
           'https://api.openai.com/v1',
           '{"type":"bearer","secret":{"fromEnvironment":"OPENAI_API_KEY"}}',
           0, 'responses', 'openai-v0', ?)`,
      ).run(NOW.toISOString());
      db.prepare(
        `UPDATE provider_connections
         SET active_revision_id = 'pcr_historical'
         WHERE connection_id = 'provider-historical'`,
      ).run();
      const service = new ManageProviderConnectionsService(
        repository,
        { createProviderApiKey: () => { throw new Error("must_not_create_secret"); } },
        new FakeClock(NOW),
        new FakeIds({
          providerConnectionRevisionIds: [
            "pcr_revised" as ProviderConnectionRevisionId,
          ],
          modelRegistryEventIds: [
            "mre_connection_revise" as ModelRegistryEventId,
          ],
        }),
        transaction(db),
      );

      const revised = service.revise({
        connectionId: "provider-historical" as ProviderConnectionId,
        expectedRevision: 0,
        traceId: "connection-revise",
      });

      expect(revised.revisions).toContainEqual(expect.objectContaining({
        revisionId: "pcr_revised",
        state: "draft",
        presetVersion: "openai-v0",
      }));
    });
  });

  it("creates replacement API keys as immutable draft references without moving the active head", () => {
    usingFixture("connection-replacement-key", ({ db, repository }) => {
      const clock = new FakeClock(NOW);
      const ids = new FakeIds({
        providerConnectionRevisionIds: [
          "pcr_initial" as ProviderConnectionRevisionId,
          "pcr_replacement" as ProviderConnectionRevisionId,
        ],
        managedSecretVersionIds: ["msv_replacement" as ManagedSecretVersionId],
        modelRegistryEventIds: [
          "mre_connection_create" as ModelRegistryEventId,
          "mre_connection_revise" as ModelRegistryEventId,
        ],
      });
      const secretStore = new SqliteEncryptedSecretStore(db, {
        MYAGENT_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      });
      const secrets = new ManageSecretsService(secretStore, repository, clock, ids);
      const service = new ManageProviderConnectionsService(
        repository,
        secrets,
        clock,
        ids,
        transaction(db),
      );

      const created = service.create({
        connectionId: "provider-a" as ProviderConnectionId,
        displayName: "Provider A",
        providerKind: "openai",
        credential: {
          type: "environment",
          fromEnvironment: "OPENAI_API_KEY",
        },
        traceId: "connection-create",
      });
      expect(created.revisions).toEqual([
        expect.objectContaining({
          revisionId: "pcr_initial",
          state: "draft",
          baseUrl: "https://api.openai.com/v1",
          protocolPreference: "responses",
          presetVersion: "openai-v1",
        }),
      ]);
      db.prepare(
        `UPDATE provider_connection_revisions
         SET state = 'active'
         WHERE revision_id = 'pcr_initial'`,
      ).run();
      db.prepare(
        "UPDATE provider_connections SET active_revision_id = 'pcr_initial' WHERE connection_id = 'provider-a'",
      ).run();

      const revised = service.revise({
        connectionId: "provider-a" as ProviderConnectionId,
        expectedRevision: 0,
        replacementApiKey: {
          secretId: "provider-a-key",
          plaintext: "replacement-provider-secret",
        },
        traceId: "connection-revise",
      });

      expect(revised.activeRevisionId).toBe("pcr_initial");
      expect(revised.recordRevision).toBe(1);
      expect(revised.revisions).toEqual([
        expect.objectContaining({
          revisionId: "pcr_initial",
          state: "active",
          auth: {
            type: "bearer",
            secret: { fromEnvironment: "OPENAI_API_KEY" },
          },
        }),
        expect.objectContaining({
          revisionId: "pcr_replacement",
          state: "draft",
          auth: {
            type: "bearer",
            secret: { managedSecretVersionId: "msv_replacement" },
          },
          presetVersion: "openai-v1",
        }),
      ]);
      expect(secretStore.resolve("msv_replacement" as ManagedSecretVersionId)).toBe(
        "replacement-provider-secret",
      );
      expect(JSON.stringify(db.prepare(
        `SELECT version_id, secret_id, key_id, hex(ciphertext) AS ciphertext,
                hex(nonce) AS nonce, hex(authentication_tag) AS tag
         FROM managed_secret_versions`,
      ).all())).not.toContain("replacement-provider-secret");
      expect(JSON.stringify(db.prepare(
        "SELECT payload_json FROM model_registry_events ORDER BY event_id",
      ).all())).not.toContain("replacement-provider-secret");

      const before = {
        activeRevisionId: repository.getConnection(
          "provider-a" as ProviderConnectionId,
        ).activeRevisionId,
        revisions: tableCount(db, "provider_connection_revisions"),
        secrets: tableCount(db, "managed_secret_versions"),
      };
      expect(() => service.revise({
        connectionId: "provider-a" as ProviderConnectionId,
        expectedRevision: 99,
        replacementApiKey: {
          secretId: "provider-a-key",
          plaintext: "must-not-persist",
        },
        traceId: "connection-stale",
      })).toThrowError(expect.objectContaining({ code: "revision_conflict" }));
      expect({
        activeRevisionId: repository.getConnection(
          "provider-a" as ProviderConnectionId,
        ).activeRevisionId,
        revisions: tableCount(db, "provider_connection_revisions"),
        secrets: tableCount(db, "managed_secret_versions"),
      }).toEqual(before);
    });
  });

  it("rolls back a replacement Secret and draft after a late Registry failure", () => {
    usingFixture("connection-replacement-rollback", ({ db, repository }) => {
      const clock = new FakeClock(NOW);
      const ids = new FakeIds({
        providerConnectionRevisionIds: [
          "pcr_initial" as ProviderConnectionRevisionId,
          "pcr_rolled_back" as ProviderConnectionRevisionId,
        ],
        managedSecretVersionIds: ["msv_rolled_back" as ManagedSecretVersionId],
        modelRegistryEventIds: [
          "mre_duplicate" as ModelRegistryEventId,
          "mre_duplicate" as ModelRegistryEventId,
        ],
      });
      const secretStore = new SqliteEncryptedSecretStore(db, {
        MYAGENT_MASTER_KEY: Buffer.alloc(32, 11).toString("base64"),
      });
      const service = new ManageProviderConnectionsService(
        repository,
        new ManageSecretsService(secretStore, repository, clock, ids),
        clock,
        ids,
        transaction(db),
      );
      service.create({
        connectionId: "provider-rollback" as ProviderConnectionId,
        displayName: "Provider Rollback",
        providerKind: "openai",
        credential: {
          type: "environment",
          fromEnvironment: "OPENAI_API_KEY",
        },
        traceId: "connection-create",
      });
      db.prepare(
        `UPDATE provider_connection_revisions
         SET state = 'active'
         WHERE revision_id = 'pcr_initial'`,
      ).run();
      db.prepare(
        `UPDATE provider_connections
         SET active_revision_id = 'pcr_initial'
         WHERE connection_id = 'provider-rollback'`,
      ).run();

      expect(() => service.revise({
        connectionId: "provider-rollback" as ProviderConnectionId,
        expectedRevision: 0,
        replacementApiKey: {
          secretId: "provider-rollback-key",
          plaintext: "replacement-must-roll-back",
        },
        traceId: "connection-revise",
      })).toThrow("UNIQUE constraint failed: model_registry_events.event_id");

      expect(tableCount(db, "managed_secret_versions")).toBe(0);
      expect(tableCount(db, "provider_connection_revisions")).toBe(1);
      expect(tableCount(db, "model_registry_events")).toBe(1);
      expect(repository.getConnection(
        "provider-rollback" as ProviderConnectionId,
      )).toMatchObject({
        activeRevisionId: "pcr_initial",
        recordRevision: 0,
        revisions: [expect.objectContaining({ revisionId: "pcr_initial" })],
      });
    });
  });
});

function assignments(
  repository: SqliteModelRegistryRepository,
  eventIds: readonly string[],
): AssignModelService {
  return new AssignModelService(
    repository,
    new FakeClock(NOW),
    new FakeIds({
      modelRegistryEventIds: eventIds.map((id) => id as ModelRegistryEventId),
    }),
  );
}

function usingFixture(
  name: string,
  run: (fixture: {
    db: DatabaseSync;
    repository: SqliteModelRegistryRepository;
  }) => void,
): void {
  const connection = openDatabase({
    path: tempPath(`${name}.db`),
    busyTimeoutMs: 5_000,
  });
  try {
    migrate(connection.db);
    run({
      db: connection.db,
      repository: new SqliteModelRegistryRepository(connection.db),
    });
  } finally {
    connection.close();
  }
}

function seedActiveProfiles(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO provider_connections (
       connection_id, display_name, provider_kind, active_revision_id,
       record_revision, created_at, updated_at
     ) VALUES ('connection-a', 'Connection', 'openai', NULL, 0, ?, ?)`,
  ).run(NOW.toISOString(), NOW.toISOString());
  db.prepare(
    `INSERT INTO provider_connection_revisions (
       revision_id, connection_id, state, base_url, auth_json,
       allow_insecure_http, protocol_preference, preset_version, created_at
     ) VALUES ('pcr_active', 'connection-a', 'active', 'https://api.openai.com/v1',
       '{"type":"none"}', 0, 'responses', 'openai-v1', ?)`,
  ).run(NOW.toISOString());
  db.prepare(
    "UPDATE provider_connections SET active_revision_id = 'pcr_active' WHERE connection_id = 'connection-a'",
  ).run();
  seedProfile(db, "assistant", "Assistant", "mpr_old");
  seedProfile(db, "research", "Research", "mpr_new");
}

function seedProfile(
  db: DatabaseSync,
  profileId: string,
  displayName: string,
  revisionId: string,
): void {
  db.prepare(
    `INSERT INTO model_profiles (
       profile_id, display_name, active_revision_id, record_revision,
       created_at, updated_at
     ) VALUES (?, ?, NULL, 0, ?, ?)`,
  ).run(profileId, displayName, NOW.toISOString(), NOW.toISOString());
  seedProfileRevision(db, { profileId, revisionId, state: "active" });
  db.prepare(
    "UPDATE model_profiles SET active_revision_id = ? WHERE profile_id = ?",
  ).run(revisionId, profileId);
}

function seedProfileRevision(
  db: DatabaseSync,
  input: { profileId: string; revisionId: string; state: "active" | "superseded" },
): void {
  db.prepare(
    `INSERT INTO model_profile_revisions (
       revision_id, profile_id, connection_revision_id, state,
       provider_model_id, invocation_protocol, max_input_tokens,
       context_window_source, capability_baseline,
       verified_capabilities_json, created_at
     ) VALUES (?, ?, 'pcr_active', ?, 'model-test', 'responses', 32768,
       'operator', 'text_and_single_tool_call_v1',
       '["streaming_text","single_tool_call"]', ?)`,
  ).run(input.revisionId, input.profileId, input.state, NOW.toISOString());
}

function tableCount(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  }).count;
}

function transaction(db: DatabaseSync): {
  run<Result>(operation: () => Result): Result;
} {
  return {
    run: <Result>(operation: () => Result): Result =>
      withImmediateTransaction(db, operation),
  };
}
