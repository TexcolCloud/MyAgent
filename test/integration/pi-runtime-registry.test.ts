import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { openDatabase, withImmediateTransaction } from "../../src/adapters/sqlite/database.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { SqliteModelRegistryRepository } from "../../src/adapters/sqlite/model-registry-repository.js";
import { AgentResolver } from "../../src/application/agent-resolver.js";
import { ManageModelProfilesService } from "../../src/application/manage-model-profiles.js";
import { ManageProviderConnectionsService } from "../../src/application/manage-provider-connections.js";
import { VerifyModelService } from "../../src/application/verify-model.js";
import type { AgentDefinitionRevision } from "../../src/domain/agent-revision.js";
import type {
  AgentId,
  DiscoveryGenerationId,
  ModelProfileId,
  ModelProfileRevisionId,
  ModelRegistryEventId,
  ModelVerificationId,
  ProviderConnectionId,
  ProviderConnectionRevisionId,
} from "../../src/domain/ids.js";
import { DEFAULT_RUN_LIMITS } from "../../src/domain/limits.js";
import type { PiRuntimeContract } from "../../src/domain/pi-runtime.js";
import { ModelProviderError } from "../../src/ports/model.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { FakeIds } from "../helpers/fake-ids.js";
import { ScriptedModel, completedText } from "../helpers/scripted-model.js";
import { tempPath } from "../helpers/temp-dir.js";

const NOW = new Date("2026-08-11T00:00:00.000Z");
const CONNECTION_ID = "anthropic" as ProviderConnectionId;
const CONNECTION_REVISION_ID = "pcr_anthropic" as ProviderConnectionRevisionId;
const PROFILE_ID = "claude" as ModelProfileId;
const PROFILE_REVISION_ID = "mpr_claude" as ModelProfileRevisionId;
const VERIFICATION_ID = "ver_claude" as ModelVerificationId;
const AGENT_ID = "primary" as AgentId;

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
  compatibility: { supportsDeveloperRole: false },
};

describe("persisted Pi runtime registry", () => {
  it("uses the exact stored contract for verification and Agent snapshots", async () => {
    await usingFixture("stored-contract", async ({ db, repository }) => {
      const clock = new FakeClock(NOW);
      const ids = new FakeIds({
        providerConnectionRevisionIds: [CONNECTION_REVISION_ID],
        modelProfileRevisionIds: [PROFILE_REVISION_ID],
        modelVerificationIds: [VERIFICATION_ID],
        modelRegistryEventIds: [
          eventId("connection-create"),
          eventId("profile-create"),
          eventId("verification-queue"),
          eventId("verification-complete"),
        ],
      });
      const connections = new ManageProviderConnectionsService(
        repository,
        {
          assertVersionActive: () => undefined,
          createProviderApiKey: () => { throw new Error("must_not_create_secret"); },
        },
        clock,
        ids,
        { run: <Result>(operation: () => Result): Result =>
          withImmediateTransaction(db, operation) },
      );
      const profiles = new ManageModelProfilesService(repository, clock, ids);

      const connection = connections.create({
        connectionId: CONNECTION_ID,
        displayName: "Anthropic",
        providerKind: "openai_compatible",
        providerDriver: "pi/anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        credential: { type: "none" },
        protocolPreference: "responses",
        traceId: "trace-connection",
      });
      expect(connection).toMatchObject({
        providerDriver: "pi/anthropic",
        providerKind: "openai_compatible",
      });
      repository.recordDiscovery({
        connectionRevisionId: CONNECTION_REVISION_ID,
        generationId: "dgn_anthropic" as DiscoveryGenerationId,
        expectedRevision: 0,
        state: "empty",
        models: [],
        eventId: eventId("discovery"),
        traceId: "trace-discovery",
        now: NOW,
      });
      repository.promoteConnection({
        connectionId: CONNECTION_ID,
        revisionId: CONNECTION_REVISION_ID,
        expectedRevision: 1,
        eventId: eventId("connection-promote"),
        traceId: "trace-connection-promote",
        now: NOW,
      });

      profiles.create({
        profileId: PROFILE_ID,
        displayName: "Claude",
        connectionRevisionId: CONNECTION_REVISION_ID,
        providerModelId: ANTHROPIC_CONTRACT.modelId,
        invocationProtocol: "responses",
        piRuntime: ANTHROPIC_CONTRACT,
        maxInputTokens: ANTHROPIC_CONTRACT.contextWindow,
        contextWindowSource: "preset",
        traceId: "trace-profile",
      });

      const model = new ScriptedModel();
      model.script(
        completedText("ok"),
        {
          chunks: [
            {
              type: "tool_call",
              callId: "provider-call",
              name: "capability_probe",
              arguments: { nonce: "probe" },
            },
            { type: "completed", finishReason: "tool_call" },
          ],
        },
      );
      const verifier = new VerifyModelService({
        registry: repository,
        model,
        clock,
        ids,
        requestTimeoutMs: 5_000,
        jobTimeoutMs: 30_000,
        createNonce: () => "probe",
      });
      verifier.queue({
        profileId: PROFILE_ID,
        profileRevisionId: PROFILE_REVISION_ID,
        expectedRevision: 0,
        traceId: "trace-verification",
      });
      const claimed = repository.claimVerification({
        leaseOwner: "worker-a",
        now: NOW,
        leaseUntil: new Date(NOW.getTime() + 60_000),
      });
      if (claimed === null) throw new Error("verification_not_claimed");
      await verifier.runClaimed(claimed, new AbortController().signal);

      expect(model.requests).toHaveLength(2);
      for (const request of model.requests) {
        expect(request.model.piRuntime).toEqual(ANTHROPIC_CONTRACT);
        expect(Object.isFrozen(request.model.piRuntime)).toBe(true);
        expect(Object.isFrozen(request.model.piRuntime?.compatibility)).toBe(true);
      }

      const currentProfile = repository.getProfile(PROFILE_ID);
      repository.promoteProfile({
        profileId: PROFILE_ID,
        revisionId: PROFILE_REVISION_ID,
        expectedRevision: currentProfile.recordRevision,
        eventId: eventId("profile-promote"),
        traceId: "trace-profile-promote",
        now: NOW,
      });
      repository.setAssignment({
        agentId: AGENT_ID,
        profileRevisionId: PROFILE_REVISION_ID,
        source: "explicit",
        expectedRevision: 0,
        eventId: eventId("assignment"),
        traceId: "trace-assignment",
        now: NOW,
      });

      const snapshot = new AgentResolver({
        catalog: { resolve: () => ({ id: AGENT_ID, definition: AGENT_DEFINITION }) },
        registry: repository,
        secrets: { resolve: () => { throw new Error("must_not_resolve_no_auth"); } },
      }).resolve(AGENT_ID);
      expect(snapshot.model.piRuntime).toEqual(ANTHROPIC_CONTRACT);
      expect(Object.isFrozen(snapshot.model.piRuntime)).toBe(true);
      expect(Object.isFrozen(snapshot.model.piRuntime?.compatibility)).toBe(true);
    });
  });

  it("does not create a fallback revision or Verification for a failed Pi profile", async () => {
    await usingFixture("failed-verification", async ({ repository }) => {
      repository.createConnection({
        connectionId: CONNECTION_ID,
        displayName: "Anthropic",
        providerKind: "openai_compatible",
        providerDriver: "pi/anthropic",
        revision: {
          revisionId: CONNECTION_REVISION_ID,
          connectionId: CONNECTION_ID,
          state: "draft",
          baseUrl: "https://api.anthropic.com/v1",
          auth: { type: "none" },
          allowInsecureHttp: false,
          protocolPreference: "responses",
          presetVersion: "pi-test-v1",
          createdAt: NOW,
        },
        eventId: eventId("connection-create"),
        traceId: "trace-connection",
        now: NOW,
      });
      repository.createProfile({
        profileId: PROFILE_ID,
        displayName: "Claude",
        revision: {
          revisionId: PROFILE_REVISION_ID,
          profileId: PROFILE_ID,
          connectionRevisionId: CONNECTION_REVISION_ID,
          state: "draft",
          providerModelId: ANTHROPIC_CONTRACT.modelId,
          invocationProtocol: "responses",
          piRuntime: ANTHROPIC_CONTRACT,
          maxInputTokens: ANTHROPIC_CONTRACT.contextWindow,
          contextWindowSource: "preset",
          capabilityBaseline: "text_and_single_tool_call_v1",
          verifiedCapabilities: [],
          createdAt: NOW,
        },
        eventId: eventId("profile-create"),
        traceId: "trace-profile",
        now: NOW,
      });
      repository.queueVerification({
        verificationId: VERIFICATION_ID,
        profileRevisionId: PROFILE_REVISION_ID,
        expectedRevision: 0,
        capabilityBaseline: "text_and_single_tool_call_v1",
        eventId: eventId("verification-queue"),
        traceId: "trace-verification",
        now: NOW,
      });
      const claimed = repository.claimVerification({
        leaseOwner: "worker-a",
        now: NOW,
        leaseUntil: new Date(NOW.getTime() + 60_000),
      });
      if (claimed === null) throw new Error("verification_not_claimed");

      const model = new ScriptedModel();
      model.script({
        chunks: [],
        error: new ModelProviderError({
          code: "invocation_protocol_unsupported",
          transient: false,
          status: 404,
        }),
      });
      const verifier = new VerifyModelService({
        registry: repository,
        model,
        clock: new FakeClock(NOW),
        ids: new FakeIds({
          modelProfileRevisionIds: ["mpr_forbidden_fallback" as ModelProfileRevisionId],
          modelVerificationIds: ["ver_forbidden_fallback" as ModelVerificationId],
          modelRegistryEventIds: [
            eventId("forbidden-fallback"),
            eventId("verification-complete"),
          ],
        }),
        requestTimeoutMs: 5_000,
        jobTimeoutMs: 30_000,
      });

      const completed = await verifier.runClaimed(
        claimed,
        new AbortController().signal,
      );

      expect(completed).toMatchObject({
        state: "failed",
        resultCode: "invocation_protocol_unsupported",
        fallbackVerificationId: null,
      });
      expect(repository.getProfile(PROFILE_ID).revisions).toHaveLength(1);
      expect(repository.getVerification(VERIFICATION_ID).fallbackVerificationId).toBeNull();
    });
  });
});

const AGENT_DEFINITION: AgentDefinitionRevision = {
  definitionRevisionId: "def_primary",
  agentId: AGENT_ID,
  displayName: "Primary",
  prompt: "Be precise.",
  workspace: "D:/workspace",
  skills: [],
  policy: [],
  delegates: [],
  limits: DEFAULT_RUN_LIMITS,
  contentSha256: "1".repeat(64),
};

function eventId(value: string): ModelRegistryEventId {
  return `mre_${value}` as ModelRegistryEventId;
}

async function usingFixture(
  name: string,
  run: (fixture: {
    db: DatabaseSync;
    repository: SqliteModelRegistryRepository;
  }) => Promise<void>,
): Promise<void> {
  const connection = openDatabase({
    path: tempPath(`pi-runtime-registry-${name}.db`),
    busyTimeoutMs: 5_000,
  });
  try {
    migrate(connection.db);
    await run({
      db: connection.db,
      repository: new SqliteModelRegistryRepository(connection.db),
    });
  } finally {
    connection.close();
  }
}
