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

  it("persists first-seen Agents without a default across later defaults and reopen", () => {
    const databasePath = tempPath("assignment-no-default.db");
    const initial = (() => {
      const connection = openDatabase({ path: databasePath, busyTimeoutMs: 5_000 });
      try {
        migrate(connection.db);
        const repository = new SqliteModelRegistryRepository(connection.db);
        const service = assignments(repository, [
          "mre_sync_unassigned",
          "mre_assign_operator",
          "mre_default_old",
          "mre_sync_existing_unassigned",
          "mre_sync_researcher",
          "mre_sync_operator",
          "mre_default_new",
          "mre_sync_existing_assigned",
          "mre_sync_existing_explicit",
        ]);
        const primary = parseAgentId("primary");
        const researcher = parseAgentId("researcher");
        const operator = parseAgentId("operator");

        const firstSync = service.synchronizeAgents([primary]);
        const firstAssignment = repository.getAssignment(primary);

        createPromotedProfiles(connection.db, repository);
        const explicitBeforeSync = service.assign({
          agentId: operator,
          profileRevisionId: "mpr_old" as ModelProfileRevisionId,
          expectedRevision: 0,
          traceId: "assign-operator",
        });
        service.setDefault({
          profileId: "assistant" as ModelProfileId,
          expectedRevision: 0,
          traceId: "default-old",
        });
        const afterDefaultSync = service.synchronizeAgents([primary]);
        const afterDefaultAssignment = repository.getAssignment(primary);
        const newAgentSync = service.synchronizeAgents([researcher]);
        const newAgentAssignment = repository.getAssignment(researcher);
        const explicitSync = service.synchronizeAgents([operator]);

        service.setDefault({
          profileId: "research" as ModelProfileId,
          expectedRevision: 0,
          traceId: "default-new",
        });
        const existingAssignedSync = service.synchronizeAgents([researcher]);
        const assignedAfterDefaultChange = repository.getAssignment(researcher);
        const existingExplicitSync = service.synchronizeAgents([operator]);
        const explicitAfterDefaultChange = repository.getAssignment(operator);

        return {
          firstSync,
          firstAssignment,
          afterDefaultSync,
          afterDefaultAssignment,
          newAgentSync,
          newAgentAssignment,
          explicitBeforeSync,
          explicitSync,
          existingAssignedSync,
          assignedAfterDefaultChange,
          existingExplicitSync,
          explicitAfterDefaultChange,
          markers: agentSynchronizationMarkers(connection.db),
        };
      } finally {
        connection.close();
      }
    })();

    const reopened = (() => {
      const connection = openDatabase({ path: databasePath, busyTimeoutMs: 5_000 });
      try {
        const repository = new SqliteModelRegistryRepository(connection.db);
        const service = assignments(repository, [
          "mre_sync_reopened_unassigned",
          "mre_sync_reopened_default",
          "mre_sync_reopened_explicit",
        ]);
        const primary = parseAgentId("primary");
        const researcher = parseAgentId("researcher");
        const operator = parseAgentId("operator");

        const firstSync = service.synchronizeAgents([primary]);
        const assignedSync = service.synchronizeAgents([researcher]);
        const explicitSync = service.synchronizeAgents([operator]);
        return {
          firstSync,
          firstAssignment: repository.getAssignment(primary),
          assignedSync,
          assignedAssignment: repository.getAssignment(researcher),
          explicitSync,
          explicitAssignment: repository.getAssignment(operator),
          markers: agentSynchronizationMarkers(connection.db),
        };
      } finally {
        connection.close();
      }
    })();

    expect({
      firstSync: initial.firstSync,
      firstAssignment: initial.firstAssignment,
      afterDefaultSync: initial.afterDefaultSync,
      afterDefaultAssignment: initial.afterDefaultAssignment,
      reopenedSync: reopened.firstSync,
      reopenedAssignment: reopened.firstAssignment,
    }).toEqual({
      firstSync: [],
      firstAssignment: null,
      afterDefaultSync: [],
      afterDefaultAssignment: null,
      reopenedSync: [],
      reopenedAssignment: null,
    });
    expect(initial.newAgentSync).toEqual([
      expect.objectContaining({
        agentId: "researcher",
        modelProfileRevisionId: "mpr_old",
        source: "default",
      }),
    ]);
    expect(initial.newAgentAssignment).toMatchObject({
      modelProfileRevisionId: "mpr_old",
      source: "default",
    });
    expect(initial.existingAssignedSync).toEqual([]);
    expect(initial.assignedAfterDefaultChange).toMatchObject({
      modelProfileRevisionId: "mpr_old",
      source: "default",
    });
    expect(reopened.assignedSync).toEqual([]);
    expect(reopened.assignedAssignment).toMatchObject({
      modelProfileRevisionId: "mpr_old",
      source: "default",
    });
    expect(initial.explicitBeforeSync).toMatchObject({
      modelProfileRevisionId: "mpr_old",
      source: "explicit",
    });
    expect(initial.explicitSync).toEqual([]);
    expect(initial.existingExplicitSync).toEqual([]);
    expect(initial.explicitAfterDefaultChange).toMatchObject({
      modelProfileRevisionId: "mpr_old",
      source: "explicit",
    });
    expect(reopened.explicitSync).toEqual([]);
    expect(reopened.explicitAssignment).toMatchObject({
      modelProfileRevisionId: "mpr_old",
      source: "explicit",
    });
    expect(initial.markers).toEqual([
      {
        event_id: "mre_sync_operator",
        resource_id: "operator",
        action: "agent.synchronized",
        trace_id: "catalog.synchronize_agents",
      },
      {
        event_id: "mre_sync_unassigned",
        resource_id: "primary",
        action: "agent.synchronized",
        trace_id: "catalog.synchronize_agents",
      },
      {
        event_id: "mre_sync_researcher",
        resource_id: "researcher",
        action: "agent.synchronized",
        trace_id: "catalog.synchronize_agents",
      },
    ]);
    expect(reopened.markers).toEqual(initial.markers);
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

function createPromotedProfiles(
  db: DatabaseSync,
  repository: SqliteModelRegistryRepository,
): void {
  const connectionId = "connection-a" as ProviderConnectionId;
  const connectionRevisionId = "pcr_active" as ProviderConnectionRevisionId;
  repository.createConnection({
    ...registryContext("mre_connection_create"),
    connectionId,
    displayName: "Connection",
    providerKind: "openai",
    revision: {
      revisionId: connectionRevisionId,
      connectionId,
      state: "verified",
      baseUrl: "https://api.openai.com/v1",
      auth: { type: "none" },
      allowInsecureHttp: false,
      protocolPreference: "responses",
      presetVersion: "openai-v1",
      createdAt: NOW,
    },
  });
  db.prepare(
    `INSERT INTO discovery_generations (
       generation_id, connection_revision_id, state, fetched_at, expires_at,
       trace_id, record_revision, created_at, updated_at
     ) VALUES (?, ?, 'fresh', ?, ?, 'first-seen-setup', 0, ?, ?)`,
  ).run(
    "dgn_first_seen",
    connectionRevisionId,
    NOW.toISOString(),
    new Date(NOW.getTime() + 60_000).toISOString(),
    NOW.toISOString(),
    NOW.toISOString(),
  );
  repository.promoteConnection({
    ...registryContext("mre_connection_promote"),
    connectionId,
    revisionId: connectionRevisionId,
    expectedRevision: 0,
  });

  for (const profile of [
    {
      profileId: "assistant" as ModelProfileId,
      displayName: "Assistant",
      revisionId: "mpr_old" as ModelProfileRevisionId,
      eventSuffix: "assistant",
    },
    {
      profileId: "research" as ModelProfileId,
      displayName: "Research",
      revisionId: "mpr_new" as ModelProfileRevisionId,
      eventSuffix: "research",
    },
  ]) {
    repository.createProfile({
      ...registryContext(`mre_profile_${profile.eventSuffix}_create`),
      profileId: profile.profileId,
      displayName: profile.displayName,
      revision: {
        revisionId: profile.revisionId,
        profileId: profile.profileId,
        connectionRevisionId,
        state: "verified",
        providerModelId: `model-${profile.eventSuffix}`,
        invocationProtocol: "responses",
        maxInputTokens: 32_768,
        contextWindowSource: "operator",
        capabilityBaseline: "text_and_single_tool_call_v1",
        verifiedCapabilities: ["streaming_text", "single_tool_call"],
        createdAt: NOW,
      },
    });
    db.prepare(
      `INSERT INTO model_verifications (
         verification_id, profile_revision_id, capability_baseline, state,
         attempt_count, capabilities_json, trace_id, record_revision,
         created_at, updated_at
       ) VALUES (?, ?, 'text_and_single_tool_call_v1', 'passed', 1,
         '["streaming_text","single_tool_call"]', 'first-seen-setup', 0, ?, ?)`,
    ).run(
      `ver_${profile.eventSuffix}`,
      profile.revisionId,
      NOW.toISOString(),
      NOW.toISOString(),
    );
    repository.promoteProfile({
      ...registryContext(`mre_profile_${profile.eventSuffix}_promote`),
      profileId: profile.profileId,
      revisionId: profile.revisionId,
      expectedRevision: 0,
    });
  }
}

function registryContext(eventId: string): {
  eventId: ModelRegistryEventId;
  traceId: string;
  now: Date;
} {
  return {
    eventId: eventId as ModelRegistryEventId,
    traceId: "first-seen-setup",
    now: NOW,
  };
}

function agentSynchronizationMarkers(db: DatabaseSync): Array<{
  event_id: string;
  resource_id: string;
  action: string;
  trace_id: string;
}> {
  return db.prepare(
    `SELECT event_id, resource_id, action, trace_id
     FROM model_registry_events
     WHERE resource_type = 'agent' AND action = 'agent.synchronized'
     ORDER BY resource_id`,
  ).all() as unknown as Array<{
    event_id: string;
    resource_id: string;
    action: string;
    trace_id: string;
  }>;
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
