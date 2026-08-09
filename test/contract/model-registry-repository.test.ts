import { describe, expect, it } from "vitest";

import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "../../src/adapters/sqlite/database.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { SqliteModelRegistryRepository } from "../../src/adapters/sqlite/model-registry-repository.js";
import type { AgentId, ManagedSecretVersionId, ModelProfileId, ModelProfileRevisionId, ModelRegistryEventId, ModelVerificationId, ProviderConnectionId, ProviderConnectionRevisionId } from "../../src/domain/ids.js";
import type { ModelProfileRevision } from "../../src/domain/model-profile.js";
import type { ProviderAuth, ProviderConnectionRevision } from "../../src/domain/provider-connection.js";
import type { MutationContext } from "../../src/ports/model-registry-store.js";
import { tempPath } from "../helpers/temp-dir.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const LATER = new Date("2026-08-09T00:01:00.000Z");

describe("SqliteModelRegistryRepository", () => {
  it("creates and reads immutable Connection revisions with atomic safe audit", () => {
    usingFixture("connection-crud", ({ db, repository }) => {
      const created = repository.createConnection({
        ...context("event-create-connection", NOW),
        connectionId: connectionId("connection-a"),
        displayName: "Connection A",
        providerKind: "openai",
        revision: connectionRevision("pcr-a", "connection-a", {
          auth: { type: "bearer", secret: { fromEnvironment: "VERY_SECRET_ENV" } },
        }),
      });

      expect(created).toEqual({
        connectionId: "connection-a",
        displayName: "Connection A",
        providerKind: "openai",
        activeRevisionId: null,
        retiredAt: null,
        recordRevision: 0,
        revisions: [connectionRevision("pcr-a", "connection-a", {
          auth: { type: "bearer", secret: { fromEnvironment: "VERY_SECRET_ENV" } },
        })],
      });

      const updated = repository.createConnectionRevision({
        ...context("event-create-revision", LATER),
        connectionId: connectionId("connection-a"),
        expectedRevision: 0,
        displayName: "Connection A2",
        revision: connectionRevision("pcr-b", "connection-a", {
          baseUrl: "https://second.example.test/v1",
          createdAt: LATER,
        }),
      });
      expect(updated.recordRevision).toBe(1);
      expect(updated.displayName).toBe("Connection A2");
      expect(updated.revisions.map(({ revisionId }) => revisionId)).toEqual(["pcr-a", "pcr-b"]);
      expect(repository.listConnections()).toEqual([updated]);

      const eventRows = db.prepare(
        "SELECT action, payload_json, trace_id FROM model_registry_events ORDER BY created_at",
      ).all() as Array<{ action: string; payload_json: string; trace_id: string }>;
      expect(eventRows.map(({ action }) => action)).toEqual([
        "connection.created",
        "connection.revision_created",
      ]);
      expect(eventRows.every(({ trace_id }) => trace_id === "trace-test")).toBe(true);
      expect(eventRows.map(({ payload_json }) => JSON.parse(payload_json))).toEqual([
        {
          action: "connection.created",
          newRecordRevision: 0,
          previousRecordRevision: null,
          resourceId: "connection-a",
          timestamp: NOW.toISOString(),
          traceId: "trace-test",
        },
        {
          action: "connection.revision_created",
          newRecordRevision: 1,
          previousRecordRevision: 0,
          resourceId: "connection-a",
          revisionId: "pcr-b",
          timestamp: LATER.toISOString(),
          traceId: "trace-test",
        },
      ]);
      expect(JSON.stringify(eventRows)).not.toContain("VERY_SECRET_ENV");
      expect(JSON.stringify(eventRows)).not.toContain("second.example.test");
    });
  });

  it("rolls back a new revision and its audit event on optimistic conflict", () => {
    usingFixture("connection-conflict", ({ db, repository }) => {
      repository.createConnection(createConnectionInput("connection-a", "pcr-a"));

      expect(() => repository.createConnectionRevision({
        ...context("event-conflict", LATER),
        connectionId: connectionId("connection-a"),
        expectedRevision: 99,
        revision: connectionRevision("pcr-conflict", "connection-a", { createdAt: LATER }),
      })).toThrowError(expect.objectContaining({ code: "revision_conflict", status: 409 }));

      expect(repository.getConnection(connectionId("connection-a")).recordRevision).toBe(0);
      expect(db.prepare(
        "SELECT revision_id FROM provider_connection_revisions WHERE revision_id = ?",
      ).get("pcr-conflict")).toBeUndefined();
      expect(db.prepare("SELECT event_id FROM model_registry_events ORDER BY created_at").all())
        .toEqual([{ event_id: "event-connection-a-pcr-a" }]);
    });
  });

  it("returns revision conflict before Connection revision ownership validation", () => {
    usingFixture("connection-revision-cas-precedence", ({ db, repository }) => {
      repository.createConnection(createConnectionInput("connection-a", "pcr-a"));
      const eventCount = count(db, "model_registry_events");

      expect(() => repository.createConnectionRevision({
        ...context("event-stale-owner", LATER),
        connectionId: connectionId("connection-a"),
        expectedRevision: 99,
        revision: connectionRevision("pcr-mismatch", "different-connection"),
      })).toThrowError(expect.objectContaining({ code: "revision_conflict", status: 409 }));
      expect(db.prepare(
        "SELECT revision_id FROM provider_connection_revisions WHERE revision_id = ?",
      ).get("pcr-mismatch")).toBeUndefined();
      expect(count(db, "model_registry_events")).toBe(eventCount);
    });
  });

  it("appends an immutable Profile revision without moving its active head", () => {
    usingFixture("profile-revision", ({ db, repository }) => {
      seedActiveRegistry(db, repository);

      const updated = repository.createProfileRevision({
        ...context("event-profile-revision", LATER),
        profileId: profileId("assistant"),
        expectedRevision: 1,
        displayName: "Assistant v2",
        revision: profileRevision("mpr-b", "assistant", "pcr-a", { createdAt: LATER }),
      });

      expect(updated.activeRevisionId).toBe("mpr-a");
      expect(updated.displayName).toBe("Assistant v2");
      expect(updated.recordRevision).toBe(2);
      expect(updated.revisions.map(({ revisionId }) => revisionId)).toEqual(["mpr-a", "mpr-b"]);
      expect(db.prepare(
        `SELECT action, payload_json FROM model_registry_events
         WHERE event_id = ?`,
      ).get("event-profile-revision")).toEqual({
        action: "profile.revision_created",
        payload_json: JSON.stringify({
          action: "profile.revision_created",
          newRecordRevision: 2,
          previousRecordRevision: 1,
          resourceId: "assistant",
          revisionId: "mpr-b",
          timestamp: LATER.toISOString(),
          traceId: "trace-test",
        }),
      });
    });
  });

  it("rolls back Profile revision append on stale CAS", () => {
    usingFixture("profile-revision-conflict", ({ db, repository }) => {
      repository.createConnection(createConnectionInput("connection-a", "pcr-a"));
      repository.createProfile(createProfileInput("assistant", "mpr-a", "pcr-a"));
      const eventCount = count(db, "model_registry_events");

      expect(() => repository.createProfileRevision({
        ...context("event-profile-conflict", LATER),
        profileId: profileId("assistant"),
        expectedRevision: 99,
        displayName: "Must not persist",
        revision: profileRevision("mpr-conflict", "assistant", "pcr-a", { createdAt: LATER }),
      })).toThrowError(expect.objectContaining({ code: "revision_conflict", status: 409 }));

      expect(repository.getProfile(profileId("assistant"))).toEqual(expect.objectContaining({
        displayName: "assistant",
        activeRevisionId: null,
        recordRevision: 0,
      }));
      expect(db.prepare(
        "SELECT revision_id FROM model_profile_revisions WHERE revision_id = ?",
      ).get("mpr-conflict")).toBeUndefined();
      expect(count(db, "model_registry_events")).toBe(eventCount);
    });
  });

  it("returns revision conflict before Profile revision ownership validation", () => {
    usingFixture("profile-revision-cas-precedence", ({ db, repository }) => {
      repository.createConnection(createConnectionInput("connection-a", "pcr-a"));
      repository.createProfile(createProfileInput("assistant", "mpr-a", "pcr-a"));
      const eventCount = count(db, "model_registry_events");

      expect(() => repository.createProfileRevision({
        ...context("event-stale-owner", LATER),
        profileId: profileId("assistant"),
        expectedRevision: 99,
        revision: profileRevision("mpr-mismatch", "different-profile", "pcr-a"),
      })).toThrowError(expect.objectContaining({ code: "revision_conflict", status: 409 }));
      expect(db.prepare(
        "SELECT revision_id FROM model_profile_revisions WHERE revision_id = ?",
      ).get("mpr-mismatch")).toBeUndefined();
      expect(count(db, "model_registry_events")).toBe(eventCount);
    });
  });

  it("rejects Profile revision append after retirement", () => {
    usingFixture("profile-revision-retired", ({ db, repository }) => {
      repository.createConnection(createConnectionInput("connection-a", "pcr-a"));
      repository.createProfile(createProfileInput("assistant", "mpr-a", "pcr-a"));
      repository.retireProfile({
        ...context("event-retire", LATER),
        profileId: profileId("assistant"),
        expectedRevision: 0,
      });
      const eventCount = count(db, "model_registry_events");

      expect(() => repository.createProfileRevision({
        ...context("event-profile-retired", LATER),
        profileId: profileId("assistant"),
        expectedRevision: 1,
        revision: profileRevision("mpr-retired", "assistant", "pcr-a", { createdAt: LATER }),
      })).toThrowError(expect.objectContaining({ code: "resource_retired" }));

      expect(db.prepare(
        "SELECT revision_id FROM model_profile_revisions WHERE revision_id = ?",
      ).get("mpr-retired")).toBeUndefined();
      expect(count(db, "model_registry_events")).toBe(eventCount);
    });
  });

  it("promotes only verified exact revisions without moving existing Assignments", () => {
    usingFixture("promotion", ({ db, repository }) => {
      repository.createConnection(createConnectionInput("connection-a", "pcr-a"));
      seedSuccessfulDiscovery(db, "pcr-a", "dgn-a");
      expect(repository.promoteConnection({
        ...context("event-promote-connection", LATER),
        connectionId: connectionId("connection-a"),
        revisionId: connectionRevisionId("pcr-a"),
        expectedRevision: 0,
      }).activeRevisionId).toBe("pcr-a");

      repository.createProfile(createProfileInput("assistant", "mpr-old", "pcr-a"));
      seedPassingVerification(db, "ver-old", "mpr-old");
      repository.promoteProfile({
        ...context("event-promote-old", LATER),
        profileId: profileId("assistant"),
        revisionId: profileRevisionId("mpr-old"),
        expectedRevision: 0,
      });
      repository.setAssignment({
        ...context("event-assignment", LATER),
        agentId: agentId("primary"),
        profileRevisionId: profileRevisionId("mpr-old"),
        source: "explicit",
        expectedRevision: 0,
      });

      repository.createProfileRevision({
        ...context("event-create-new", LATER),
        profileId: profileId("assistant"),
        expectedRevision: 1,
        revision: profileRevision("mpr-new", "assistant", "pcr-a", { createdAt: LATER }),
      });
      seedPassingVerification(db, "ver-new", "mpr-new");
      const promoted = repository.promoteProfile({
        ...context("event-promote-new", LATER),
        profileId: profileId("assistant"),
        revisionId: profileRevisionId("mpr-new"),
        expectedRevision: 2,
      });

      expect(promoted.activeRevisionId).toBe("mpr-new");
      expect(promoted.revisions.map(({ revisionId, state }) => ({ revisionId, state }))).toEqual([
        { revisionId: "mpr-old", state: "superseded" },
        { revisionId: "mpr-new", state: "active" },
      ]);
      expect(repository.getAssignment(agentId("primary"))?.modelProfileRevisionId)
        .toBe("mpr-old");

      repository.createProfileRevision({
        ...context("event-create-conflict", LATER),
        profileId: profileId("assistant"),
        expectedRevision: 3,
        revision: profileRevision("mpr-conflict", "assistant", "pcr-a", { createdAt: LATER }),
      });
      seedPassingVerification(db, "ver-conflict", "mpr-conflict");
      const eventCount = count(db, "model_registry_events");
      expect(() => repository.promoteProfile({
        ...context("event-conflict", LATER),
        profileId: profileId("assistant"),
        revisionId: profileRevisionId("mpr-conflict"),
        expectedRevision: 99,
      })).toThrowError(expect.objectContaining({ code: "revision_conflict" }));
      expect(repository.getProfile(profileId("assistant")).activeRevisionId).toBe("mpr-new");
      expect(count(db, "model_registry_events")).toBe(eventCount);
    });
  });

  it.each(["draft", "failed", "superseded"] as const)(
    "rejects %s Connection revision promotion despite historical discovery",
    (state) => {
      usingFixture(`connection-state-${state}`, ({ db, repository }) => {
        repository.createConnection({
          ...createConnectionInput("connection-a", "pcr-a"),
          revision: connectionRevision("pcr-a", "connection-a", { state }),
        });
        seedSuccessfulDiscovery(db, "pcr-a", "dgn-a");
        const eventCount = count(db, "model_registry_events");

        expect(() => repository.promoteConnection({
          ...context("event-invalid-state", LATER),
          connectionId: connectionId("connection-a"),
          revisionId: connectionRevisionId("pcr-a"),
          expectedRevision: 0,
        })).toThrowError(expect.objectContaining({ code: "verification_required" }));
        expect(repository.getConnection(connectionId("connection-a")).activeRevisionId).toBeNull();
        expect(count(db, "model_registry_events")).toBe(eventCount);
      });
    },
  );

  it.each(["draft", "failed", "superseded"] as const)(
    "rejects %s Profile revision promotion despite historical Verification",
    (state) => {
      usingFixture(`profile-state-${state}`, ({ db, repository }) => {
        repository.createConnection(createConnectionInput("connection-a", "pcr-a"));
        seedSuccessfulDiscovery(db, "pcr-a", "dgn-a");
        repository.promoteConnection({
          ...context("event-promote-connection", LATER),
          connectionId: connectionId("connection-a"),
          revisionId: connectionRevisionId("pcr-a"),
          expectedRevision: 0,
        });
        repository.createProfile({
          ...createProfileInput("assistant", "mpr-a", "pcr-a"),
          revision: profileRevision("mpr-a", "assistant", "pcr-a", { state }),
        });
        seedPassingVerification(db, "ver-a", "mpr-a");
        const eventCount = count(db, "model_registry_events");

        expect(() => repository.promoteProfile({
          ...context("event-invalid-state", LATER),
          profileId: profileId("assistant"),
          revisionId: profileRevisionId("mpr-a"),
          expectedRevision: 0,
        })).toThrowError(expect.objectContaining({ code: "verification_required" }));
        expect(repository.getProfile(profileId("assistant")).activeRevisionId).toBeNull();
        expect(count(db, "model_registry_events")).toBe(eventCount);
      });
    },
  );

  it("returns revision conflict before invalid Connection promotion evidence", () => {
    usingFixture("connection-cas-precedence", ({ db, repository }) => {
      repository.createConnection(createConnectionInput("connection-a", "pcr-a"));
      const eventCount = count(db, "model_registry_events");

      expect(() => repository.promoteConnection({
        ...context("event-stale", LATER),
        connectionId: connectionId("connection-a"),
        revisionId: connectionRevisionId("pcr-missing"),
        expectedRevision: 99,
      })).toThrowError(expect.objectContaining({ code: "revision_conflict", status: 409 }));
      expect(repository.getConnection(connectionId("connection-a")).activeRevisionId).toBeNull();
      expect(count(db, "model_registry_events")).toBe(eventCount);
    });
  });

  it("returns revision conflict before invalid Profile promotion evidence", () => {
    usingFixture("profile-cas-precedence", ({ db, repository }) => {
      repository.createConnection(createConnectionInput("connection-a", "pcr-a"));
      repository.createProfile(createProfileInput("assistant", "mpr-a", "pcr-a"));
      const eventCount = count(db, "model_registry_events");

      expect(() => repository.promoteProfile({
        ...context("event-stale", LATER),
        profileId: profileId("assistant"),
        revisionId: profileRevisionId("mpr-missing"),
        expectedRevision: 99,
      })).toThrowError(expect.objectContaining({ code: "revision_conflict", status: 409 }));
      expect(repository.getProfile(profileId("assistant")).activeRevisionId).toBeNull();
      expect(count(db, "model_registry_events")).toBe(eventCount);
    });
  });

  it("returns revision conflict before invalid default target eligibility", () => {
    usingFixture("default-cas-precedence", ({ db, repository }) => {
      const eventCount = count(db, "model_registry_events");

      expect(() => repository.setDefaultProfile({
        ...context("event-stale", LATER),
        profileId: profileId("missing"),
        expectedRevision: 99,
      })).toThrowError(expect.objectContaining({ code: "revision_conflict", status: 409 }));
      expect(repository.getDefaultProfile()).toBeNull();
      expect(count(db, "model_registry_events")).toBe(eventCount);
    });
  });

  it("returns revision conflict before invalid Assignment target eligibility", () => {
    usingFixture("assignment-cas-precedence", ({ db, repository }) => {
      const eventCount = count(db, "model_registry_events");

      expect(() => repository.setAssignment({
        ...context("event-stale", LATER),
        agentId: agentId("primary"),
        profileRevisionId: profileRevisionId("mpr-missing"),
        source: "explicit",
        expectedRevision: 99,
      })).toThrowError(expect.objectContaining({ code: "revision_conflict", status: 409 }));
      expect(repository.getAssignment(agentId("primary"))).toBeNull();
      expect(count(db, "model_registry_events")).toBe(eventCount);
    });
  });

  it("requires exact discovery and baseline Verification evidence for promotion", () => {
    usingFixture("promotion-evidence", ({ db, repository }) => {
      repository.createConnection(createConnectionInput("connection-a", "pcr-a"));
      expect(() => repository.promoteConnection({
        ...context("event-no-discovery", LATER),
        connectionId: connectionId("connection-a"),
        revisionId: connectionRevisionId("pcr-a"),
        expectedRevision: 0,
      })).toThrowError(expect.objectContaining({ code: "verification_required" }));

      seedSuccessfulDiscovery(db, "pcr-a", "dgn-a");
      repository.promoteConnection({
        ...context("event-promote-connection", LATER),
        connectionId: connectionId("connection-a"),
        revisionId: connectionRevisionId("pcr-a"),
        expectedRevision: 0,
      });
      repository.createProfile(createProfileInput("assistant", "mpr-a", "pcr-a"));
      expect(() => repository.promoteProfile({
        ...context("event-no-verification", LATER),
        profileId: profileId("assistant"),
        revisionId: profileRevisionId("mpr-a"),
        expectedRevision: 0,
      })).toThrowError(expect.objectContaining({ code: "verification_required" }));

      seedPassingVerification(db, "ver-a", "mpr-a", ["streaming_text"]);
      expect(() => repository.promoteProfile({
        ...context("event-partial-verification", LATER),
        profileId: profileId("assistant"),
        revisionId: profileRevisionId("mpr-a"),
        expectedRevision: 0,
      })).toThrowError(expect.objectContaining({ code: "verification_required" }));
    });
  });

  it("snapshots defaults only for new unassigned Agents and retirement preserves exact Assignments", () => {
    usingFixture("assignment-default", ({ db, repository }) => {
      seedActiveRegistry(db, repository);
      repository.setAssignment({
        ...context("event-explicit", LATER),
        agentId: agentId("primary"),
        profileRevisionId: profileRevisionId("mpr-a"),
        source: "explicit",
        expectedRevision: 0,
      });
      expect(repository.setDefaultProfile({
        ...context("event-default", LATER),
        profileId: profileId("assistant"),
        expectedRevision: 0,
      })).toEqual({ profileId: "assistant", recordRevision: 0 });

      expect(repository.synchronizeAgents({
        ...context("event-sync", LATER),
        agentIds: [agentId("primary"), agentId("researcher")],
      })).toEqual([
        expect.objectContaining({
          agentId: "researcher",
          modelProfileRevisionId: "mpr-a",
          source: "default",
          recordRevision: 0,
        }),
      ]);
      expect(repository.getAssignment(agentId("primary"))?.source).toBe("explicit");

      const retiredProfile = repository.retireProfile({
        ...context("event-retire-profile", LATER),
        profileId: profileId("assistant"),
        expectedRevision: 1,
      });
      expect(retiredProfile.retiredAt).toEqual(LATER);
      expect(repository.getAssignment(agentId("primary"))?.modelProfileRevisionId).toBe("mpr-a");
      expect(() => repository.setAssignment({
        ...context("event-new-after-retire", LATER),
        agentId: agentId("other"),
        profileRevisionId: profileRevisionId("mpr-a"),
        source: "explicit",
        expectedRevision: 0,
      })).toThrow();

      const retiredConnection = repository.retireConnection({
        ...context("event-retire-connection", LATER),
        connectionId: connectionId("connection-a"),
        expectedRevision: 1,
      });
      expect(retiredConnection.retiredAt).toEqual(LATER);
      expect(repository.getAssignment(agentId("researcher"))?.modelProfileRevisionId).toBe("mpr-a");
    });
  });

  it("blocks purge for exact stable, revision, Assignment, default, and retained Run references", () => {
    usingFixture("purge", ({ db, repository }) => {
      seedActiveRegistry(db, repository);
      repository.setDefaultProfile({
        ...context("event-default", LATER),
        profileId: profileId("assistant"),
        expectedRevision: 0,
      });
      repository.setAssignment({
        ...context("event-assignment", LATER),
        agentId: agentId("primary"),
        profileRevisionId: profileRevisionId("mpr-a"),
        source: "explicit",
        expectedRevision: 0,
      });

      expect(() => repository.purgeProfile({
        ...context("event-purge-profile", LATER),
        profileId: profileId("assistant"),
        expectedRevision: 1,
      })).toThrowError(expect.objectContaining({ code: "resource_in_use" }));
      expect(() => repository.purgeConnection({
        ...context("event-purge-connection", LATER),
        connectionId: connectionId("connection-a"),
        expectedRevision: 1,
      })).toThrowError(expect.objectContaining({ code: "resource_in_use" }));

      db.prepare("DELETE FROM model_assignments").run();
      db.prepare("DELETE FROM default_model_profile").run();
      db.prepare(
        `INSERT INTO agent_revisions (
           revision_id, agent_id, content_json, content_sha256, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "retained-revision", "primary",
        '{"modelProfileRevisionId":"mpr-a","providerConnectionRevisionId":"pcr-a"}',
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        NOW.toISOString(),
      );
      expect(() => repository.purgeProfile({
        ...context("event-purge-profile-run", LATER),
        profileId: profileId("assistant"),
        expectedRevision: 1,
      })).toThrowError(expect.objectContaining({ code: "resource_in_use" }));

      db.prepare("DELETE FROM agent_revisions WHERE revision_id = ?").run("retained-revision");
      repository.purgeProfile({
        ...context("event-purge-profile-final", LATER),
        profileId: profileId("assistant"),
        expectedRevision: 1,
      });
      repository.purgeConnection({
        ...context("event-purge-connection-final", LATER),
        connectionId: connectionId("connection-a"),
        expectedRevision: 1,
      });
      expect(repository.listProfiles()).toEqual([]);
      expect(repository.listConnections()).toEqual([]);
    });
  });

  it("finds Managed Secret references in immutable revisions and retained snapshots", () => {
    usingFixture("secret-references", ({ db, repository }) => {
      const versionId = "msv-a" as ManagedSecretVersionId;
      repository.createConnection({
        ...createConnectionInput("connection-a", "pcr-a"),
        revision: connectionRevision("pcr-a", "connection-a", {
          auth: {
            type: "bearer",
            secret: { managedSecretVersionId: versionId },
          } as unknown as ProviderAuth,
        }),
      });
      db.prepare(
        `INSERT INTO agent_revisions (
           revision_id, agent_id, content_json, content_sha256, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "retained-revision", "primary",
        '{"auth":{"secret":{"managedSecretVersionId":"msv-a"}}}',
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        NOW.toISOString(),
      );

      expect(repository.inspectSecretReferences(versionId)).toEqual([
        { type: "provider_connection_revision", id: "pcr-a" },
        { type: "retained_run_snapshot", id: "retained-revision" },
      ]);
    });
  });
});

interface Fixture {
  db: DatabaseSync;
  repository: SqliteModelRegistryRepository;
}

function usingFixture(name: string, run: (fixture: Fixture) => void): void {
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

function createConnectionInput(connection: string, revision: string) {
  return {
    ...context(`event-${connection}-${revision}`, NOW),
    connectionId: connectionId(connection),
    displayName: connection,
    providerKind: "openai" as const,
    revision: connectionRevision(revision, connection),
  };
}

function createProfileInput(profile: string, revision: string, connectionRevision: string) {
  return {
    ...context(`event-${profile}-${revision}`, NOW),
    profileId: profileId(profile),
    displayName: profile,
    revision: profileRevision(revision, profile, connectionRevision),
  };
}

function connectionRevision(
  revision: string,
  connection: string,
  overrides: Partial<ProviderConnectionRevision> = {},
): ProviderConnectionRevision {
  return {
    revisionId: connectionRevisionId(revision),
    connectionId: connectionId(connection),
    state: "verified",
    baseUrl: "https://api.example.test/v1",
    auth: { type: "none" },
    allowInsecureHttp: false,
    protocolPreference: "responses",
    presetVersion: "2026-08-09",
    createdAt: NOW,
    ...overrides,
  };
}

function profileRevision(
  revision: string,
  profile: string,
  connectionRevision: string,
  overrides: Partial<ModelProfileRevision> = {},
): ModelProfileRevision {
  return {
    revisionId: profileRevisionId(revision),
    profileId: profileId(profile),
    connectionRevisionId: connectionRevisionId(connectionRevision),
    providerModelId: "gpt-test",
    invocationProtocol: "responses",
    maxInputTokens: 32_768,
    contextWindowSource: "operator",
    capabilityBaseline: "text_and_single_tool_call_v1",
    verifiedCapabilities: ["streaming_text", "single_tool_call"],
    state: "verified",
    createdAt: NOW,
    ...overrides,
  };
}

function context(event: string, now: Date): MutationContext {
  return {
    eventId: event as ModelRegistryEventId,
    traceId: "trace-test",
    now,
  };
}

function seedSuccessfulDiscovery(db: DatabaseSync, revision: string, generation: string): void {
  db.prepare(
    `INSERT INTO discovery_generations (
       generation_id, connection_revision_id, state, fetched_at, expires_at,
       trace_id, record_revision, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    generation, revision, "fresh", NOW.toISOString(), LATER.toISOString(),
    "trace-discovery", 0, NOW.toISOString(), NOW.toISOString(),
  );
}

function seedPassingVerification(
  db: DatabaseSync,
  verification: string,
  revision: string,
  capabilities: readonly string[] = ["streaming_text", "single_tool_call"],
): void {
  db.prepare(
    `INSERT INTO model_verifications (
       verification_id, profile_revision_id, capability_baseline, state,
       attempt_count, capabilities_json, trace_id, record_revision,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    verificationId(verification), revision, "text_and_single_tool_call_v1", "passed",
    1, JSON.stringify(capabilities), "trace-verification", 0,
    NOW.toISOString(), NOW.toISOString(),
  );
}

function seedActiveRegistry(db: DatabaseSync, repository: SqliteModelRegistryRepository): void {
  repository.createConnection(createConnectionInput("connection-a", "pcr-a"));
  seedSuccessfulDiscovery(db, "pcr-a", "dgn-a");
  repository.promoteConnection({
    ...context("event-promote-connection", LATER),
    connectionId: connectionId("connection-a"),
    revisionId: connectionRevisionId("pcr-a"),
    expectedRevision: 0,
  });
  repository.createProfile(createProfileInput("assistant", "mpr-a", "pcr-a"));
  seedPassingVerification(db, "ver-a", "mpr-a");
  repository.promoteProfile({
    ...context("event-promote-profile", LATER),
    profileId: profileId("assistant"),
    revisionId: profileRevisionId("mpr-a"),
    expectedRevision: 0,
  });
}

function count(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function agentId(value: string): AgentId {
  return value as AgentId;
}

function connectionId(value: string): ProviderConnectionId {
  return value as ProviderConnectionId;
}

function connectionRevisionId(value: string): ProviderConnectionRevisionId {
  return value as ProviderConnectionRevisionId;
}

function profileId(value: string): ModelProfileId {
  return value as ModelProfileId;
}

function profileRevisionId(value: string): ModelProfileRevisionId {
  return value as ModelProfileRevisionId;
}

function verificationId(value: string): ModelVerificationId {
  return value as ModelVerificationId;
}
