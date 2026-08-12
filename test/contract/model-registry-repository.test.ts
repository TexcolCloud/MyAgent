import { describe, expect, it } from "vitest";

import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "../../src/adapters/sqlite/database.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { SqliteModelRegistryRepository } from "../../src/adapters/sqlite/model-registry-repository.js";
import type { AgentId, DiscoveryGenerationId, ManagedSecretVersionId, ModelProfileId, ModelProfileRevisionId, ModelRegistryEventId, ModelVerificationId, ProviderConnectionId, ProviderConnectionRevisionId } from "../../src/domain/ids.js";
import type { ModelProfileRevision } from "../../src/domain/model-profile.js";
import type { PiRuntimeContract } from "../../src/domain/pi-runtime.js";
import type { ProviderAuth, ProviderConnectionRevision } from "../../src/domain/provider-connection.js";
import type { MutationContext } from "../../src/ports/model-registry-store.js";
import { tempPath } from "../helpers/temp-dir.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const LATER = new Date("2026-08-09T00:01:00.000Z");
const ANTHROPIC_CONTRACT: PiRuntimeContract = {
  kind: "pi_ai",
  piVersion: "0.73.1",
  driverId: "pi/anthropic",
  catalogProviderId: "anthropic",
  api: "anthropic-messages",
  providerCompatibilityContract: "none",
  modelId: "claude-sonnet-4-20250514",
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  compatibility: {
    supportsDeveloperRole: false,
    supportsStrictMode: false,
  },
};

const DEEPSEEK_RESPONSES_CONTRACT: PiRuntimeContract = {
  kind: "pi_ai",
  piVersion: "0.73.1",
  driverId: "pi/deepseek",
  catalogProviderId: "deepseek",
  api: "openai-responses",
  providerCompatibilityContract: "deepseek-responses-v1",
  modelId: "deepseek-v4-flash",
  contextWindow: 1_000_000,
  maxOutputTokens: 384_000,
  compatibility: {
    requiresReasoningContentOnAssistantMessages: true,
    thinkingFormat: "deepseek",
  },
};

describe("SqliteModelRegistryRepository", () => {
  it("persists a Provider Driver and canonical immutable Pi runtime contract", () => {
    usingFixture("pi-runtime-contract", ({ db, repository }) => {
      const connection = repository.createConnection({
        ...createConnectionInput("connection-pi", "pcr-pi"),
        providerDriver: "pi/anthropic",
      });
      const profile = repository.createProfile({
        ...createProfileInput("profile-pi", "mpr-pi", "pcr-pi"),
        revision: profileRevision("mpr-pi", "profile-pi", "pcr-pi", {
          providerModelId: "claude-sonnet-4-20250514",
          invocationProtocol: "responses",
          piRuntime: ANTHROPIC_CONTRACT,
        }),
      });

      expect(connection.providerDriver).toBe("pi/anthropic");
      expect(connection.providerKind).toBe("openai_compatible");
      expect(profile.revisions[0]?.piRuntime).toEqual(ANTHROPIC_CONTRACT);
      expect(db.prepare(
        "SELECT runtime_contract_json FROM model_profile_revisions WHERE revision_id = ?",
      ).get("mpr-pi")).toEqual({
        runtime_contract_json:
          '{"api":"anthropic-messages","catalogProviderId":"anthropic",' +
          '"compatibility":{"supportsDeveloperRole":false,"supportsStrictMode":false},' +
          '"contextWindow":200000,"driverId":"pi/anthropic","kind":"pi_ai",' +
          '"maxOutputTokens":64000,"modelId":"claude-sonnet-4-20250514",' +
          '"piVersion":"0.73.1","providerCompatibilityContract":"none"}',
      });
      expect(() => db.prepare(
        "UPDATE model_profile_revisions SET runtime_contract_json = ? WHERE revision_id = ?",
      ).run("{}", "mpr-pi")).toThrowError("immutable_model_profile_revision");
      expect(() => db.prepare(
        "UPDATE provider_connections SET provider_driver = ? WHERE connection_id = ?",
      ).run("pi/openai", "connection-pi")).toThrowError("immutable_provider_driver");
    });
  });

  it.each(["apiKey", "baseUrl"])(
    "rejects transport or credential compatibility field %s",
    (unsafeField) => {
      usingFixture(`unsafe-pi-runtime-${unsafeField}`, ({ db, repository }) => {
        repository.createConnection({
          ...createConnectionInput("connection-pi", "pcr-pi"),
          providerDriver: "pi/anthropic",
        });
        const unsafeContract = {
          ...ANTHROPIC_CONTRACT,
          compatibility: {
            ...ANTHROPIC_CONTRACT.compatibility,
            [unsafeField]: unsafeField === "apiKey"
              ? "secret-must-not-persist"
              : "https://provider.example/v1",
          },
        };

        expect(() => repository.createProfile({
          ...createProfileInput("profile-pi", "mpr-pi", "pcr-pi"),
          revision: profileRevision("mpr-pi", "profile-pi", "pcr-pi", {
            providerModelId: unsafeContract.modelId,
            invocationProtocol: "responses",
            piRuntime: unsafeContract,
          }),
        })).toThrowError(expect.objectContaining({ code: "invalid_model_profile" }));
        expect(db.prepare(
          "SELECT runtime_contract_json FROM model_profile_revisions WHERE revision_id = ?",
        ).get("mpr-pi")).toBeUndefined();
      });
    },
  );

  it.each([
    ["maxTokensField", "secret"],
    ["thinkingFormat", "https://provider.example/v1"],
  ] as const)(
    "rejects invalid Pi compatibility enum %s=%s",
    (field, value) => {
      usingFixture(`invalid-pi-runtime-${field}`, ({ db, repository }) => {
        repository.createConnection({
          ...createConnectionInput("connection-pi", "pcr-pi"),
          providerDriver: "pi/anthropic",
        });
        const unsafeContract = {
          ...ANTHROPIC_CONTRACT,
          compatibility: {
            ...ANTHROPIC_CONTRACT.compatibility,
            [field]: value,
          },
        };

        expect(() => repository.createProfile({
          ...createProfileInput("profile-pi", "mpr-pi", "pcr-pi"),
          revision: profileRevision("mpr-pi", "profile-pi", "pcr-pi", {
            providerModelId: unsafeContract.modelId,
            invocationProtocol: "responses",
            piRuntime: unsafeContract,
          }),
        })).toThrowError(expect.objectContaining({ code: "invalid_model_profile" }));
        expect(db.prepare(
          "SELECT runtime_contract_json FROM model_profile_revisions WHERE revision_id = ?",
        ).get("mpr-pi")).toBeUndefined();
      });
    },
  );

  it.each([
    ["maxTokensField", "max_completion_tokens"],
    ["maxTokensField", "max_tokens"],
    ["thinkingFormat", "openai"],
    ["thinkingFormat", "openrouter"],
    ["thinkingFormat", "deepseek"],
    ["thinkingFormat", "zai"],
    ["thinkingFormat", "qwen"],
    ["thinkingFormat", "qwen-chat-template"],
  ] as const)(
    "persists valid Pi compatibility enum %s=%s",
    (field, value) => {
      usingFixture(`valid-pi-runtime-${field}-${value}`, ({ repository }) => {
        repository.createConnection({
          ...createConnectionInput("connection-pi", "pcr-pi"),
          providerDriver: "pi/anthropic",
        });
        const runtime = {
          ...ANTHROPIC_CONTRACT,
          compatibility: {
            ...ANTHROPIC_CONTRACT.compatibility,
            [field]: value,
          },
        };

        const profile = repository.createProfile({
          ...createProfileInput("profile-pi", "mpr-pi", "pcr-pi"),
          revision: profileRevision("mpr-pi", "profile-pi", "pcr-pi", {
            providerModelId: runtime.modelId,
            invocationProtocol: "responses",
            piRuntime: runtime,
          }),
        });

        expect(profile.revisions[0]?.piRuntime?.compatibility).toMatchObject({
          [field]: value,
        });
      });
    },
  );

  it("maps malformed persisted Pi runtime JSON to the typed invalid Profile error", () => {
    usingFixture("malformed-pi-runtime-contract", ({ db, repository }) => {
      repository.createConnection(createConnectionInput("connection-pi", "pcr-pi"));
      db.prepare(
        `INSERT INTO model_profiles (
           profile_id, display_name, active_revision_id, retired_at,
           record_revision, created_at, updated_at
         ) VALUES (?, ?, NULL, NULL, 0, ?, ?)`,
      ).run("profile-malformed", "Malformed", NOW.toISOString(), NOW.toISOString());
      db.prepare(
        `INSERT INTO model_profile_revisions (
           revision_id, profile_id, connection_revision_id, state,
           provider_model_id, invocation_protocol, max_input_tokens,
           context_window_source, capability_baseline,
           verified_capabilities_json, runtime_contract_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "mpr-malformed", "profile-malformed", "pcr-pi", "draft",
        "claude-test", "responses", 200_000, "preset",
        "text_and_single_tool_call_v1", "[]", "{not-json", NOW.toISOString(),
      );

      expect(() => repository.getProfile(profileId("profile-malformed")))
        .toThrowError(expect.objectContaining({ code: "invalid_model_profile" }));
    });
  });

  it("reads a historical Pi contract without a compatibility field as none", () => {
    usingFixture("historical-pi-runtime-contract", ({ db, repository }) => {
      repository.createConnection(createConnectionInput("connection-pi", "pcr-pi"));
      insertRawRuntimeContract(db, "profile-historical", "mpr-historical", "pcr-pi", {
        ...ANTHROPIC_CONTRACT,
        providerCompatibilityContract: undefined,
      });

      expect(repository.getProfile(profileId("profile-historical")).revisions[0]?.piRuntime)
        .toMatchObject({ providerCompatibilityContract: "none" });
      expect(db.prepare(
        "SELECT runtime_contract_json FROM model_profile_revisions WHERE revision_id = ?",
      ).get("mpr-historical")).toEqual({
        runtime_contract_json: expect.not.stringContaining("providerCompatibilityContract"),
      });
    });
  });

  it("rejects an unknown persisted compatibility contract", () => {
    usingFixture("unknown-pi-runtime-contract", ({ db, repository }) => {
      repository.createConnection(createConnectionInput("connection-pi", "pcr-pi"));
      insertRawRuntimeContract(db, "profile-unknown", "mpr-unknown", "pcr-pi", {
        ...ANTHROPIC_CONTRACT,
        providerCompatibilityContract: "unreleased-v99",
      });

      expect(() => repository.getProfile(profileId("profile-unknown")))
        .toThrowError(expect.objectContaining({ code: "invalid_model_profile" }));
    });
  });

  it.each([
    ["driver", { driverId: "pi/openai" }],
    ["provider", { catalogProviderId: "openai" }],
    ["API", { api: "openai-completions" }],
    ["model", { modelId: "deepseek-chat" }],
    ["Pi version", { piVersion: "0.74.0" }],
    ["context window", { contextWindow: 128_000 }],
    ["output limit", { maxOutputTokens: 8_192 }],
    ["compatibility", { compatibility: { supportsUsageInStreaming: true } }],
    ["null compatibility", { compatibility: null }],
    ["missing compatibility", { compatibility: undefined }],
  ] as const)(
    "rejects a persisted DeepSeek Responses contract paired with another %s",
    (_case, override) => {
      usingFixture(`corrupt-deepseek-responses-${_case}`, ({ db, repository }) => {
        repository.createConnection(createConnectionInput("connection-pi", "pcr-pi"));
        insertRawRuntimeContract(db, "profile-corrupt", "mpr-corrupt", "pcr-pi", {
          ...DEEPSEEK_RESPONSES_CONTRACT,
          ...override,
        });

        expect(() => repository.getProfile(profileId("profile-corrupt")))
          .toThrowError(expect.objectContaining({ code: "invalid_model_profile" }));
      });
    },
  );

  it("replaces discovery generations atomically and preserves stale models on refresh failure", () => {
    usingFixture("discovery-generations", ({ db, repository }) => {
      repository.createConnection(createConnectionInput("connection-a", "pcr-a"));

      expect(repository.recordDiscovery({
        ...context("event-discovery-a", NOW),
        connectionRevisionId: connectionRevisionId("pcr-a"),
        generationId: discoveryGenerationId("dgn-a"),
        expectedRevision: 0,
        state: "fresh",
        models: [
          { id: "model-a", owner: "provider", createdAt: NOW },
          { id: "model-old" },
        ],
        expiresAt: LATER,
      })).toEqual({
        connectionRevisionId: "pcr-a",
        state: "fresh",
        models: [
          { id: "model-a", owner: "provider", createdAt: NOW },
          { id: "model-old" },
        ],
        fetchedAt: NOW,
        expiresAt: LATER,
      });
      expect(repository.getConnection(connectionId("connection-a"))).toMatchObject({
        activeRevisionId: null,
        recordRevision: 1,
        revisions: [expect.objectContaining({ revisionId: "pcr-a", state: "verified" })],
      });

      expect(() => repository.recordDiscovery({
        ...context("event-discovery-invalid", LATER),
        connectionRevisionId: connectionRevisionId("pcr-a"),
        generationId: discoveryGenerationId("dgn-invalid"),
        expectedRevision: 1,
        state: "fresh",
        models: [{ id: "duplicate" }, { id: "duplicate" }],
        expiresAt: new Date("2026-08-09T00:02:00.000Z"),
      })).toThrow();
      expect(db.prepare(
        "SELECT generation_id FROM discovery_generations WHERE generation_id = ?",
      ).get("dgn-invalid")).toBeUndefined();
      expect(repository.getConnection(connectionId("connection-a")).recordRevision).toBe(1);

      expect(repository.recordDiscovery({
        ...context("event-discovery-failed", LATER),
        connectionRevisionId: connectionRevisionId("pcr-a"),
        generationId: discoveryGenerationId("dgn-failed"),
        expectedRevision: 1,
        state: "failed",
        models: [],
        error: { code: "provider_unavailable", status: 503 },
      })).toEqual({
        connectionRevisionId: "pcr-a",
        state: "stale",
        models: [
          { id: "model-a", owner: "provider", createdAt: NOW },
          { id: "model-old" },
        ],
        fetchedAt: NOW,
        expiresAt: LATER,
        refreshError: {
          code: "provider_unavailable",
          status: 503,
          traceId: "trace-test",
        },
      });
      expect(repository.getDiscoveredModels(
        connectionRevisionId("pcr-a"),
        LATER,
      )).toEqual(expect.objectContaining({
        state: "stale",
        models: [
          { id: "model-a", owner: "provider", createdAt: NOW },
          { id: "model-old" },
        ],
        refreshError: { code: "provider_unavailable", status: 503, traceId: "trace-test" },
      }));
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM discovered_models WHERE generation_id = ?",
      ).get("dgn-failed")).toEqual({ count: 0 });
    });
  });

  it("uses durable insertion order for equal-timestamp success and failed refreshes", () => {
    usingFixture("discovery-equal-timestamp", ({ repository }) => {
      repository.createConnection(createConnectionInput("connection-a", "pcr-a"));
      repository.recordDiscovery({
        ...context("event-discovery-z", NOW),
        connectionRevisionId: connectionRevisionId("pcr-a"),
        generationId: discoveryGenerationId("dgn-z"),
        expectedRevision: 0,
        state: "fresh",
        models: [{ id: "model-old" }],
        expiresAt: LATER,
      });

      expect(repository.recordDiscovery({
        ...context("event-discovery-m", NOW),
        connectionRevisionId: connectionRevisionId("pcr-a"),
        generationId: discoveryGenerationId("dgn-m"),
        expectedRevision: 1,
        state: "fresh",
        models: [{ id: "model-new" }],
        expiresAt: LATER,
      })).toEqual({
        connectionRevisionId: "pcr-a",
        state: "fresh",
        models: [{ id: "model-new" }],
        fetchedAt: NOW,
        expiresAt: LATER,
      });

      expect(repository.recordDiscovery({
        ...context("event-discovery-a", NOW),
        connectionRevisionId: connectionRevisionId("pcr-a"),
        generationId: discoveryGenerationId("dgn-a"),
        expectedRevision: 2,
        state: "failed",
        models: [],
        error: { code: "provider_unavailable", status: 503 },
      })).toEqual({
        connectionRevisionId: "pcr-a",
        state: "stale",
        models: [{ id: "model-new" }],
        fetchedAt: NOW,
        expiresAt: LATER,
        refreshError: {
          code: "provider_unavailable",
          status: 503,
          traceId: "trace-test",
        },
      });
    });
  });

  it.each(["fresh", "empty"] as const)(
    "makes only the exact Connection revision verified after %s discovery",
    (state) => {
      usingFixture(`discovery-${state}`, ({ repository }) => {
        repository.createConnection(createConnectionInput("connection-a", "pcr-a"));
        repository.createConnectionRevision({
          ...context("event-revision-b", NOW),
          connectionId: connectionId("connection-a"),
          expectedRevision: 0,
          revision: connectionRevision("pcr-b", "connection-a", { state: "draft" }),
        });

        repository.recordDiscovery({
          ...context(`event-discovery-${state}`, LATER),
          connectionRevisionId: connectionRevisionId("pcr-b"),
          generationId: discoveryGenerationId(`dgn-${state}`),
          expectedRevision: 1,
          state,
          models: state === "fresh" ? [{ id: "model-b" }] : [],
          expiresAt: new Date("2026-08-09T00:02:00.000Z"),
        });

        const connection = repository.getConnection(connectionId("connection-a"));
        expect(connection.activeRevisionId).toBeNull();
        expect(connection.revisions.map(({ revisionId, state: revisionState }) => ({
          revisionId,
          state: revisionState,
        }))).toEqual([
          { revisionId: "pcr-a", state: "verified" },
          { revisionId: "pcr-b", state: "verified" },
        ]);
      });
    },
  );

  it.each(["unsupported", "failed"] as const)(
    "does not verify a Connection revision after %s discovery",
    (state) => {
      usingFixture(`discovery-${state}`, ({ repository }) => {
        repository.createConnection({
          ...createConnectionInput("connection-a", "pcr-a"),
          revision: connectionRevision("pcr-a", "connection-a", { state: "draft" }),
        });

        repository.recordDiscovery({
          ...context(`event-discovery-${state}`, LATER),
          connectionRevisionId: connectionRevisionId("pcr-a"),
          generationId: discoveryGenerationId(`dgn-${state}`),
          expectedRevision: 0,
          state,
          models: [],
          ...(state === "failed"
            ? { error: { code: "provider_unavailable" } }
            : {}),
        });

        expect(repository.getConnection(connectionId("connection-a")).revisions[0]?.state)
          .toBe("draft");
      });
    },
  );

  it("rolls back an atomic legacy Verification queue when its final audit fails", () => {
    usingFixture("legacy-verification-rollback", ({ db, repository }) => {
      repository.createConnection(createConnectionInput("connection-a", "pcr-a"));
      repository.createProfile({
        ...createProfileInput("profile-a", "mpr-legacy", "pcr-a"),
        revision: profileRevision("mpr-legacy", "profile-a", "pcr-a", {
          state: "legacy_trusted",
        }),
      });
      db.prepare(
        "UPDATE model_profiles SET active_revision_id = ? WHERE profile_id = ?",
      ).run("mpr-legacy", "profile-a");
      const before = repository.getProfile(profileId("profile-a"));
      const auditCountBefore = count(db, "model_registry_events");
      const verificationCountBefore = count(db, "model_verifications");

      expect(() => repository.queueLegacyProfileVerification({
        ...context("event-legacy-candidate", LATER),
        profileId: profileId("profile-a"),
        legacyProfileRevisionId: profileRevisionId("mpr-legacy"),
        candidateRevisionId: profileRevisionId("mpr-candidate"),
        verificationId: verificationId("ver-candidate"),
        verificationEventId: "event-profile-a-mpr-legacy" as ModelRegistryEventId,
        expectedRevision: before.recordRevision,
      })).toThrow(/UNIQUE constraint failed: model_registry_events.event_id/);

      expect(repository.getProfile(profileId("profile-a"))).toEqual(before);
      expect(count(db, "model_verifications")).toBe(verificationCountBefore);
      expect(count(db, "model_registry_events")).toBe(auditCountBefore);
      expect(db.prepare(
        "SELECT revision_id FROM model_profile_revisions WHERE revision_id = ?",
      ).get("mpr-candidate")).toBeUndefined();
    });
  });

  it("atomically copies legacy effective values into one queued Verification candidate", () => {
    usingFixture("legacy-verification-success", ({ db, repository }) => {
      repository.createConnection(createConnectionInput("connection-a", "pcr-a"));
      repository.createProfile({
        ...createProfileInput("profile-a", "mpr-legacy", "pcr-a"),
        revision: profileRevision("mpr-legacy", "profile-a", "pcr-a", {
          state: "legacy_trusted",
          providerModelId: "legacy-effective-model",
          invocationProtocol: "chat_completions",
          maxInputTokens: 65_536,
          contextWindowSource: "assumed_32768",
          verifiedCapabilities: ["streaming_text", "single_tool_call"],
        }),
      });
      db.prepare(
        "UPDATE model_profiles SET active_revision_id = ? WHERE profile_id = ?",
      ).run("mpr-legacy", "profile-a");
      const before = repository.getProfile(profileId("profile-a"));

      const queued = repository.queueLegacyProfileVerification({
        ...context("event-legacy-success-candidate", LATER),
        profileId: profileId("profile-a"),
        legacyProfileRevisionId: profileRevisionId("mpr-legacy"),
        candidateRevisionId: profileRevisionId("mpr-candidate"),
        verificationId: verificationId("ver-candidate"),
        verificationEventId: "event-legacy-success-verification" as ModelRegistryEventId,
        expectedRevision: before.recordRevision,
      });

      expect(queued).toMatchObject({
        verificationId: "ver-candidate",
        profileRevisionId: "mpr-candidate",
        capabilityBaseline: "text_and_single_tool_call_v1",
        state: "queued",
        attemptCount: 0,
      });
      expect(repository.getProfile(profileId("profile-a"))).toMatchObject({
        activeRevisionId: "mpr-legacy",
        recordRevision: before.recordRevision + 1,
        revisions: [
          expect.objectContaining({
            revisionId: "mpr-legacy",
            state: "legacy_trusted",
            verifiedCapabilities: ["streaming_text", "single_tool_call"],
          }),
          {
            revisionId: "mpr-candidate",
            profileId: "profile-a",
            connectionRevisionId: "pcr-a",
            providerModelId: "legacy-effective-model",
            invocationProtocol: "chat_completions",
            maxInputTokens: 65_536,
            contextWindowSource: "assumed_32768",
            capabilityBaseline: "text_and_single_tool_call_v1",
            verifiedCapabilities: [],
            state: "verifying",
            createdAt: LATER,
          },
        ],
      });
      expect(db.prepare(
        `SELECT event_id, resource_type, resource_id, action, trace_id, created_at
         FROM model_registry_events
         WHERE event_id IN (?, ?)
         ORDER BY event_id`,
      ).all(
        "event-legacy-success-candidate",
        "event-legacy-success-verification",
      )).toEqual([
        {
          event_id: "event-legacy-success-candidate",
          resource_type: "model_profile",
          resource_id: "profile-a",
          action: "profile.revision_created",
          trace_id: "trace-test",
          created_at: LATER.toISOString(),
        },
        {
          event_id: "event-legacy-success-verification",
          resource_type: "model_verification",
          resource_id: "ver-candidate",
          action: "verification.queued",
          trace_id: "trace-test",
          created_at: LATER.toISOString(),
        },
      ]);
    });
  });

  it("claims FIFO Verification work and reclaims expiry after restart without counting an attempt", () => {
    usingFixture("verification-claim", ({ db, repository }) => {
      repository.createConnection(createConnectionInput("connection-a", "pcr-a"));
      repository.createProfile(createProfileInput("profile-a", "mpr-a", "pcr-a"));
      repository.createProfile(createProfileInput("profile-b", "mpr-b", "pcr-a"));
      repository.queueVerification(queueInput("ver-a", "mpr-a", "event-queue-a", NOW));
      repository.queueVerification(queueInput(
        "ver-b",
        "mpr-b",
        "event-queue-b",
        new Date("2026-08-09T00:00:01.000Z"),
      ));

      const first = repository.claimVerification({
        leaseOwner: "worker-a",
        now: NOW,
        leaseUntil: new Date("2026-08-09T00:00:30.000Z"),
      });
      expect(first).toMatchObject({
        verificationId: "ver-a",
        state: "running",
        attemptCount: 0,
        leaseOwner: "worker-a",
      });
      expect(repository.claimVerification({
        leaseOwner: "worker-b",
        now: new Date("2026-08-09T00:00:10.000Z"),
        leaseUntil: new Date("2026-08-09T00:00:40.000Z"),
      })?.verificationId).toBe("ver-b");
      expect(repository.claimVerification({
        leaseOwner: "worker-c",
        now: new Date("2026-08-09T00:00:20.000Z"),
        leaseUntil: new Date("2026-08-09T00:00:50.000Z"),
      })).toBeNull();
      const restartedRepository = new SqliteModelRegistryRepository(db);
      expect(restartedRepository.claimVerification({
        leaseOwner: "worker-c",
        now: new Date("2026-08-09T00:00:30.000Z"),
        leaseUntil: new Date("2026-08-09T00:01:00.000Z"),
      })).toMatchObject({
        verificationId: "ver-a",
        state: "running",
        attemptCount: 0,
        leaseOwner: "worker-c",
      });
    });
  });

  it("counts attempts only for a live owner and renews only an unexpired owned lease", () => {
    usingFixture("verification-attempt-renew", ({ repository }) => {
      repository.createConnection(createConnectionInput("connection-a", "pcr-a"));
      repository.createProfile(createProfileInput("profile-a", "mpr-a", "pcr-a"));
      repository.queueVerification(queueInput("ver-a", "mpr-a", "event-queue", NOW));
      repository.claimVerification({
        leaseOwner: "worker-a",
        now: NOW,
        leaseUntil: new Date("2026-08-09T00:00:30.000Z"),
      });

      expect(() => repository.beginVerificationAttempt({
        verificationId: verificationId("ver-a"),
        leaseOwner: "worker-b",
        now: new Date("2026-08-09T00:00:10.000Z"),
      })).toThrow();
      expect(repository.beginVerificationAttempt({
        verificationId: verificationId("ver-a"),
        leaseOwner: "worker-a",
        now: new Date("2026-08-09T00:00:10.000Z"),
      }).attemptCount).toBe(1);
      expect(repository.renewVerificationLease({
        verificationId: verificationId("ver-a"),
        leaseOwner: "worker-b",
        now: new Date("2026-08-09T00:00:20.000Z"),
        leaseUntil: new Date("2026-08-09T00:01:00.000Z"),
      })).toBe(false);
      expect(repository.renewVerificationLease({
        verificationId: verificationId("ver-a"),
        leaseOwner: "worker-a",
        now: new Date("2026-08-09T00:00:20.000Z"),
        leaseUntil: new Date("2026-08-09T00:01:00.000Z"),
      })).toBe(true);
      expect(repository.beginVerificationAttempt({
        verificationId: verificationId("ver-a"),
        leaseOwner: "worker-a",
        now: new Date("2026-08-09T00:00:59.000Z"),
      }).attemptCount).toBe(2);
      expect(repository.renewVerificationLease({
        verificationId: verificationId("ver-a"),
        leaseOwner: "worker-a",
        now: new Date("2026-08-09T00:01:00.000Z"),
        leaseUntil: new Date("2026-08-09T00:01:30.000Z"),
      })).toBe(false);
      expect(() => repository.completeVerification({
        ...context("event-expired-complete", new Date("2026-08-09T00:01:00.000Z")),
        verificationId: verificationId("ver-a"),
        leaseOwner: "worker-a",
        outcome: "failed",
        capabilities: [],
        resultCode: "provider_unavailable",
      })).toThrowError(expect.objectContaining({ code: "verification_lease_lost" }));
      expect(repository.getVerification(verificationId("ver-a")).attemptCount).toBe(2);
    });
  });

  it("cancels non-terminal Verification work idempotently and retains its history", () => {
    usingFixture("verification-cancel", ({ db, repository }) => {
      repository.createConnection(createConnectionInput("connection-a", "pcr-a"));
      repository.createProfile(createProfileInput("profile-a", "mpr-a", "pcr-a"));
      repository.queueVerification(queueInput("ver-a", "mpr-a", "event-queue", NOW));

      const cancelled = repository.cancelVerification({
        ...context("event-cancel", LATER),
        verificationId: verificationId("ver-a"),
        expectedRevision: 0,
      });
      expect(cancelled).toMatchObject({
        verificationId: "ver-a",
        state: "cancelled",
        cancellationRequestedAt: LATER,
        recordRevision: 1,
      });
      expect(repository.cancelVerification({
        ...context("event-cancel-repeat", LATER),
        verificationId: verificationId("ver-a"),
        expectedRevision: 1,
      })).toEqual(cancelled);
      expect(db.prepare(
        "SELECT verification_id, state FROM model_verifications WHERE verification_id = ?",
      ).get("ver-a")).toEqual({ verification_id: "ver-a", state: "cancelled" });
      expect(db.prepare(
        "SELECT action FROM model_registry_events WHERE resource_id = ? ORDER BY created_at",
      ).all("ver-a")).toEqual([
        { action: "verification.queued" },
        { action: "verification.cancelled" },
      ]);
    });
  });

  it("completes passing Verification with safe evidence and exact revision state only", () => {
    usingFixture("verification-complete-pass", ({ db, repository }) => {
      repository.createConnection({
        ...createConnectionInput("connection-a", "pcr-a"),
        revision: connectionRevision("pcr-a", "connection-a", { state: "draft" }),
      });
      repository.createProfile({
        ...createProfileInput("profile-a", "mpr-a", "pcr-a"),
        revision: profileRevision("mpr-a", "profile-a", "pcr-a", {
          state: "draft",
          verifiedCapabilities: [],
        }),
      });
      repository.queueVerification(queueInput("ver-a", "mpr-a", "event-queue", NOW));
      repository.claimVerification({
        leaseOwner: "worker-a",
        now: NOW,
        leaseUntil: new Date("2026-08-09T00:02:00.000Z"),
      });
      repository.beginVerificationAttempt({
        verificationId: verificationId("ver-a"),
        leaseOwner: "worker-a",
        now: new Date("2026-08-09T00:00:10.000Z"),
      });

      expect(() => repository.completeVerification({
        ...context("event-wrong-owner", LATER),
        verificationId: verificationId("ver-a"),
        leaseOwner: "worker-b",
        outcome: "passed",
        capabilities: ["streaming_text", "single_tool_call"],
      })).toThrowError(expect.objectContaining({ code: "verification_lease_lost" }));
      expect(repository.getVerification(verificationId("ver-a"))).toMatchObject({
        state: "running",
        leaseOwner: "worker-a",
        attemptCount: 1,
      });

      const completed = repository.completeVerification({
        ...context("event-complete", LATER),
        verificationId: verificationId("ver-a"),
        leaseOwner: "worker-a",
        outcome: "passed",
        capabilities: ["streaming_text", "single_tool_call"],
        usage: { inputTokens: 7, outputTokens: 3 },
      });
      expect(completed).toMatchObject({
        state: "passed",
        attemptCount: 1,
        capabilities: ["streaming_text", "single_tool_call"],
        usage: { inputTokens: 7, outputTokens: 3 },
        leaseOwner: null,
        leaseExpiresAt: null,
        fallbackVerificationId: null,
      });
      expect(repository.getProfile(profileId("profile-a"))).toMatchObject({
        activeRevisionId: null,
        revisions: [expect.objectContaining({
          revisionId: "mpr-a",
          state: "verified",
          verifiedCapabilities: ["streaming_text", "single_tool_call"],
        })],
      });
      expect(repository.getConnection(connectionId("connection-a"))).toMatchObject({
        activeRevisionId: null,
        revisions: [expect.objectContaining({ revisionId: "pcr-a", state: "verified" })],
      });
      expect(db.prepare(
        `SELECT outcome, consecutive_failures, code, safe_status, trace_id
         FROM provider_health WHERE connection_revision_id = ? AND profile_revision_id = ?`,
      ).get("pcr-a", "mpr-a")).toEqual({
        outcome: "success",
        consecutive_failures: 0,
        code: null,
        safe_status: null,
        trace_id: "trace-test",
      });
      expect(JSON.stringify(db.prepare(
        "SELECT * FROM model_verifications WHERE verification_id = ?",
      ).get("ver-a"))).not.toContain("prompt");
    });
  });

  it("fails only the exact candidate and updates exact health without configuration authority", () => {
    usingFixture("verification-complete-failure", ({ db, repository }) => {
      repository.createConnection(createConnectionInput("connection-a", "pcr-a"));
      repository.createProfile(createProfileInput("profile-a", "mpr-a", "pcr-a"));
      repository.createProfileRevision({
        ...context("event-profile-b", NOW),
        profileId: profileId("profile-a"),
        expectedRevision: 0,
        revision: profileRevision("mpr-b", "profile-a", "pcr-a", {
          state: "draft",
          verifiedCapabilities: [],
        }),
      });
      repository.queueVerification(queueInput(
        "ver-b",
        "mpr-b",
        "event-queue",
        NOW,
        1,
      ));
      repository.claimVerification({
        leaseOwner: "worker-a",
        now: NOW,
        leaseUntil: new Date("2026-08-09T00:02:00.000Z"),
      });
      repository.beginVerificationAttempt({
        verificationId: verificationId("ver-b"),
        leaseOwner: "worker-a",
        now: new Date("2026-08-09T00:00:10.000Z"),
      });

      expect(repository.completeVerification({
        ...context("event-complete", LATER),
        verificationId: verificationId("ver-b"),
        leaseOwner: "worker-a",
        outcome: "failed",
        capabilities: ["streaming_text"],
        resultCode: "tool_call_unsupported",
        safeStatus: 422,
      })).toMatchObject({
        state: "failed",
        resultCode: "tool_call_unsupported",
        safeStatus: 422,
      });
      expect(repository.getProfile(profileId("profile-a")).revisions.map((revision) => ({
        revisionId: revision.revisionId,
        state: revision.state,
      }))).toEqual([
        { revisionId: "mpr-a", state: "verified" },
        { revisionId: "mpr-b", state: "failed" },
      ]);
      expect(repository.getConnection(connectionId("connection-a"))).toMatchObject({
        activeRevisionId: null,
        revisions: [expect.objectContaining({ revisionId: "pcr-a", state: "verified" })],
      });
      expect(db.prepare(
        `SELECT outcome, consecutive_failures, code, safe_status
         FROM provider_health WHERE connection_revision_id = ? AND profile_revision_id = ?`,
      ).get("pcr-a", "mpr-b")).toEqual({
        outcome: "failure",
        consecutive_failures: 1,
        code: "tool_call_unsupported",
        safe_status: 422,
      });
    });
  });

  it("rolls back every completion write when the final audit insert conflicts", () => {
    usingFixture("verification-fallback", ({ db, repository }) => {
      repository.createConnection(createConnectionInput("connection-a", "pcr-a"));
      repository.createProfile({
        ...createProfileInput("profile-a", "mpr-a", "pcr-a"),
        revision: profileRevision("mpr-a", "profile-a", "pcr-a", {
          state: "draft",
          verifiedCapabilities: [],
        }),
      });
      repository.queueVerification(queueInput("ver-a", "mpr-a", "event-queue", NOW));
      repository.claimVerification({
        leaseOwner: "worker-a",
        now: NOW,
        leaseUntil: new Date("2026-08-09T00:02:00.000Z"),
      });
      repository.beginVerificationAttempt({
        verificationId: verificationId("ver-a"),
        leaseOwner: "worker-a",
        now: new Date("2026-08-09T00:00:10.000Z"),
      });
      const fallbackRevision = profileRevision("mpr-fallback", "profile-a", "pcr-a", {
        state: "draft",
        invocationProtocol: "chat_completions",
        verifiedCapabilities: [],
        createdAt: LATER,
      });
      db.prepare(
        `INSERT INTO model_registry_events (
           event_id, resource_type, resource_id, action,
           payload_json, trace_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "event-complete-conflict",
        "test_fixture",
        "seed",
        "seeded.conflict",
        '{"seeded":true}',
        "trace-seed",
        LATER.toISOString(),
      );
      const verificationBefore = repository.getVerification(verificationId("ver-a"));
      const auditCountBefore = count(db, "model_registry_events");

      expect(() => repository.completeVerification({
        ...context("event-complete-conflict", LATER),
        verificationId: verificationId("ver-a"),
        leaseOwner: "worker-a",
        outcome: "failed",
        capabilities: [],
        resultCode: "invocation_protocol_unsupported",
        safeStatus: 404,
        fallback: {
          revision: fallbackRevision,
          verification: queueInput(
            "ver-fallback",
            "mpr-fallback",
            "event-fallback",
            LATER,
            1,
          ),
        },
      })).toThrowError(/UNIQUE constraint failed/);
      expect(repository.getVerification(verificationId("ver-a"))).toEqual(verificationBefore);
      expect(repository.getVerification(verificationId("ver-a"))).toMatchObject({
        state: "running",
        leaseOwner: "worker-a",
        leaseExpiresAt: new Date("2026-08-09T00:02:00.000Z"),
        fallbackVerificationId: null,
        recordRevision: 2,
      });
      expect(repository.getProfile(profileId("profile-a"))).toMatchObject({
        recordRevision: 1,
        revisions: [expect.objectContaining({
          revisionId: "mpr-a",
          state: "verifying",
        })],
      });
      expect(db.prepare(
        `SELECT health_id FROM provider_health
         WHERE connection_revision_id = ? AND profile_revision_id = ?`,
      ).get("pcr-a", "mpr-a")).toBeUndefined();
      expect(db.prepare(
        "SELECT revision_id FROM model_profile_revisions WHERE revision_id = ?",
      ).get("mpr-fallback")).toBeUndefined();
      expect(db.prepare(
        "SELECT verification_id FROM model_verifications WHERE verification_id = ?",
      ).get("ver-fallback")).toBeUndefined();
      expect(db.prepare(
        "SELECT event_id FROM model_registry_events WHERE event_id = ?",
      ).get("event-fallback")).toBeUndefined();
      expect(count(db, "model_registry_events")).toBe(auditCountBefore);

      const completed = repository.completeVerification({
        ...context("event-complete", LATER),
        verificationId: verificationId("ver-a"),
        leaseOwner: "worker-a",
        outcome: "failed",
        capabilities: [],
        resultCode: "invocation_protocol_unsupported",
        safeStatus: 404,
        fallback: {
          revision: fallbackRevision,
          verification: queueInput(
            "ver-fallback",
            "mpr-fallback",
            "event-fallback",
            LATER,
            1,
          ),
        },
      });
      expect(completed).toMatchObject({
        state: "failed",
        fallbackVerificationId: "ver-fallback",
      });
      expect(repository.getVerification(verificationId("ver-fallback"))).toMatchObject({
        profileRevisionId: "mpr-fallback",
        state: "queued",
        attemptCount: 0,
      });
      expect(repository.getProfile(profileId("profile-a"))).toMatchObject({
        recordRevision: 2,
        activeRevisionId: null,
        revisions: [
          expect.objectContaining({ revisionId: "mpr-a", state: "failed" }),
          expect.objectContaining({ revisionId: "mpr-fallback", state: "verifying" }),
        ],
      });
    });
  });

  it("records exact health observations without audit or Registry configuration authority", () => {
    usingFixture("provider-health", ({ db, repository }) => {
      repository.createConnection(createConnectionInput("connection-a", "pcr-a"));
      repository.createProfile(createProfileInput("profile-a", "mpr-a", "pcr-a"));
      const auditCount = count(db, "model_registry_events");
      const connectionBefore = repository.getConnection(connectionId("connection-a"));
      const profileBefore = repository.getProfile(profileId("profile-a"));

      repository.recordProviderHealth({
        connectionRevisionId: connectionRevisionId("pcr-a"),
        profileRevisionId: profileRevisionId("mpr-a"),
        outcome: "failure",
        code: "provider_unavailable",
        safeStatus: 503,
        traceId: "trace-health-1",
        observedAt: NOW,
      });
      repository.recordProviderHealth({
        connectionRevisionId: connectionRevisionId("pcr-a"),
        profileRevisionId: profileRevisionId("mpr-a"),
        outcome: "failure",
        code: "provider_rate_limited",
        safeStatus: 429,
        traceId: "trace-health-2",
        observedAt: LATER,
      });
      expect(db.prepare(
        `SELECT outcome, consecutive_failures, code, safe_status, trace_id, record_revision
         FROM provider_health WHERE connection_revision_id = ? AND profile_revision_id = ?`,
      ).get("pcr-a", "mpr-a")).toEqual({
        outcome: "failure",
        consecutive_failures: 2,
        code: "provider_rate_limited",
        safe_status: 429,
        trace_id: "trace-health-2",
        record_revision: 1,
      });
      repository.recordProviderHealth({
        connectionRevisionId: connectionRevisionId("pcr-a"),
        profileRevisionId: profileRevisionId("mpr-a"),
        outcome: "success",
        traceId: "trace-health-3",
        observedAt: new Date("2026-08-09T00:02:00.000Z"),
      });
      expect(db.prepare(
        `SELECT outcome, consecutive_failures, code, safe_status, record_revision
         FROM provider_health WHERE connection_revision_id = ? AND profile_revision_id = ?`,
      ).get("pcr-a", "mpr-a")).toEqual({
        outcome: "success",
        consecutive_failures: 0,
        code: null,
        safe_status: null,
        record_revision: 2,
      });
      expect(repository.getConnection(connectionId("connection-a"))).toEqual(connectionBefore);
      expect(repository.getProfile(profileId("profile-a"))).toEqual(profileBefore);
      expect(count(db, "model_registry_events")).toBe(auditCount);
      expect(repository.getDefaultProfile()).toBeNull();
      expect(repository.getAssignment(agentId("primary"))).toBeNull();
    });
  });

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
        providerDriver: "pi/openai",
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
        agents: [
          {
            agentId: agentId("primary"),
            eventId: "event-sync-primary" as ModelRegistryEventId,
          },
          {
            agentId: agentId("researcher"),
            eventId: "event-sync-researcher" as ModelRegistryEventId,
          },
        ],
        traceId: "trace-test",
        now: LATER,
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
      repository.setAssignment({
        ...context("event-assignment-repeated", LATER),
        agentId: agentId("researcher"),
        profileRevisionId: profileRevisionId("mpr-a"),
        source: "explicit",
        expectedRevision: 0,
      });

      expect(() => repository.purgeProfile({
        ...context("event-purge-profile", LATER),
        profileId: profileId("assistant"),
        expectedRevision: 1,
      })).toThrowError(expect.objectContaining({
        code: "resource_in_use",
        details: {
          ownerCategories: ["default_model_profile", "model_assignment"],
        },
      }));
      expect(() => repository.purgeConnection({
        ...context("event-purge-connection", LATER),
        connectionId: connectionId("connection-a"),
        expectedRevision: 1,
      })).toThrowError(expect.objectContaining({
        code: "resource_in_use",
        details: { ownerCategories: ["model_profile"] },
      }));

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
      })).toThrowError(expect.objectContaining({
        code: "resource_in_use",
        details: { ownerCategories: ["retained_run_snapshot"] },
      }));
      expect(() => repository.purgeConnection({
        ...context("event-purge-connection-run", LATER),
        connectionId: connectionId("connection-a"),
        expectedRevision: 1,
      })).toThrowError(expect.objectContaining({
        code: "resource_in_use",
        details: {
          ownerCategories: ["model_profile", "retained_run_snapshot"],
        },
      }));

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

function insertRawRuntimeContract(
  db: DatabaseSync,
  profile: string,
  revision: string,
  connectionRevision: string,
  runtime: object,
): void {
  const runtimeModelId = "modelId" in runtime && typeof runtime.modelId === "string"
    ? runtime.modelId
    : ANTHROPIC_CONTRACT.modelId;
  db.prepare(
    `INSERT INTO model_profiles (
       profile_id, display_name, active_revision_id, retired_at,
       record_revision, created_at, updated_at
     ) VALUES (?, ?, NULL, NULL, 0, ?, ?)`,
  ).run(profile, profile, NOW.toISOString(), NOW.toISOString());
  db.prepare(
    `INSERT INTO model_profile_revisions (
       revision_id, profile_id, connection_revision_id, state,
       provider_model_id, invocation_protocol, max_input_tokens,
       context_window_source, capability_baseline,
       verified_capabilities_json, runtime_contract_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    revision, profile, connectionRevision, "draft", runtimeModelId,
    "pi_ai", ANTHROPIC_CONTRACT.contextWindow, "preset",
    "text_and_single_tool_call_v1", "[]", JSON.stringify(runtime), NOW.toISOString(),
  );
}

function context(event: string, now: Date): MutationContext {
  return {
    eventId: event as ModelRegistryEventId,
    traceId: "trace-test",
    now,
  };
}

function queueInput(
  verification: string,
  profileRevision: string,
  event: string,
  now: Date,
  expectedRevision = 0,
) {
  return {
    ...context(event, now),
    verificationId: verificationId(verification),
    profileRevisionId: profileRevisionId(profileRevision),
    expectedRevision,
    capabilityBaseline: "text_and_single_tool_call_v1" as const,
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

function discoveryGenerationId(value: string): DiscoveryGenerationId {
  return value as DiscoveryGenerationId;
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
