import { describe, expect, it } from "vitest";

import { openDatabase } from "../../src/adapters/sqlite/database.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { SqliteModelRegistryRepository } from "../../src/adapters/sqlite/model-registry-repository.js";
import { SystemClock } from "../../src/adapters/system-clock.js";
import { VerifyModelService } from "../../src/application/verify-model.js";
import {
  modelProfileRevisionIdFromUuid,
  modelRegistryEventIdFromUuid,
  modelVerificationIdFromUuid,
  parseModelProfileId,
  parseProviderConnectionId,
  providerConnectionRevisionIdFromUuid,
} from "../../src/domain/ids.js";
import type { ModelVerification } from "../../src/domain/model-verification.js";
import type { ModelPort } from "../../src/ports/model.js";
import type { ModelRegistryStore } from "../../src/ports/model-registry-store.js";
import { ModelVerificationWorker } from "../../src/runtime/model-verification-worker.js";
import { FakeIds } from "../helpers/fake-ids.js";
import { completedText, ScriptedModel } from "../helpers/scripted-model.js";
import { tempPath } from "../helpers/temp-dir.js";

describe("ModelVerificationWorker", () => {
  it("claims and completes a queued Verification durably", async () => {
    const connection = openDatabase({
      path: tempPath("model-verification-worker.db"),
      busyTimeoutMs: 5_000,
    });
    let worker: ModelVerificationWorker | undefined;
    try {
      migrate(connection.db);
      const registry = new SqliteModelRegistryRepository(connection.db);
      const clock = new SystemClock();
      const profileId = parseModelProfileId("profile-worker");
      const connectionId = parseProviderConnectionId("connection-worker");
      const profileRevisionId = modelProfileRevisionIdFromUuid("worker");
      const connectionRevisionId = providerConnectionRevisionIdFromUuid("worker");
      const verificationId = modelVerificationIdFromUuid("worker");
      registry.createConnection({
        connectionId,
        displayName: "Worker Connection",
        providerKind: "openai_compatible",
        revision: {
          revisionId: connectionRevisionId,
          connectionId,
          state: "draft",
          baseUrl: "https://example.invalid/v1",
          auth: { type: "none" },
          allowInsecureHttp: false,
          protocolPreference: "chat_completions",
          presetVersion: "custom-v1",
          createdAt: clock.now(),
        },
        eventId: modelRegistryEventIdFromUuid("create-connection"),
        traceId: "trace-worker",
        now: clock.now(),
      });
      registry.createProfile({
        profileId,
        displayName: "Worker Profile",
        revision: {
          revisionId: profileRevisionId,
          profileId,
          connectionRevisionId,
          providerModelId: "model-worker",
          invocationProtocol: "chat_completions",
          maxInputTokens: 32_768,
          contextWindowSource: "assumed_32768",
          capabilityBaseline: "text_and_single_tool_call_v1",
          verifiedCapabilities: [],
          state: "draft",
          createdAt: clock.now(),
        },
        eventId: modelRegistryEventIdFromUuid("create-profile"),
        traceId: "trace-worker",
        now: clock.now(),
      });
      const model = new ScriptedModel();
      model.script(completedText("generated-secret-marker"), {
        chunks: [
          {
            type: "tool_call",
            callId: "provider-call-secret-marker",
            name: "capability_probe",
            arguments: { nonce: "argument-secret-marker" },
          },
          { type: "completed", finishReason: "tool_call" },
        ],
      });
      const ids = new FakeIds({
        modelVerificationIds: [verificationId],
        modelRegistryEventIds: [
          modelRegistryEventIdFromUuid("queue"),
          modelRegistryEventIdFromUuid("complete"),
        ],
      });
      const verify = new VerifyModelService({
        registry,
        model,
        clock,
        ids,
        requestTimeoutMs: 30_000,
        jobTimeoutMs: 120_000,
        createNonce: () => "argument-secret-marker",
      });
      verify.queue({
        profileId,
        profileRevisionId,
        expectedRevision: 0,
        traceId: "trace-worker",
      });
      worker = new ModelVerificationWorker({
        registry,
        verify,
        clock,
        workerId: "verification-worker",
        idleDelayMs: 5,
      });

      worker.start();
      await waitFor(() => registry.getVerification(verificationId).state === "passed");
      await worker.stop();
      worker = undefined;

      expect(registry.getVerification(verificationId)).toMatchObject({
        state: "passed",
        attemptCount: 2,
        capabilities: ["streaming_text", "single_tool_call"],
        leaseOwner: null,
      });
      expect(registry.getProfile(profileId).activeRevisionId).toBeNull();
      expect(model.requests).toHaveLength(2);
      const durableEvidence = JSON.stringify({
        verifications: connection.db.prepare("SELECT * FROM model_verifications").all(),
        events: connection.db.prepare("SELECT * FROM model_registry_events").all(),
        health: connection.db.prepare("SELECT * FROM provider_health").all(),
      });
      expect(durableEvidence).not.toContain("generated-secret-marker");
      expect(durableEvidence).not.toContain("argument-secret-marker");
      expect(durableEvidence).not.toContain("provider-call-secret-marker");
      expect(connection.db.prepare("SELECT COUNT(*) AS count FROM runs").get())
        .toEqual({ count: 0 });
      expect(connection.db.prepare("SELECT COUNT(*) AS count FROM tool_calls").get())
        .toEqual({ count: 0 });
      expect(connection.db.prepare("SELECT COUNT(*) AS count FROM approvals").get())
        .toEqual({ count: 0 });
    } finally {
      await worker?.stop().catch(() => undefined);
      connection.close();
    }
  });

  it("safely fails an unexpected job error and continues the lane", async () => {
    const firstId = modelVerificationIdFromUuid("unexpected-first");
    const secondId = modelVerificationIdFromUuid("unexpected-second");
    const claims = [
      runningVerification(firstId, "worker-unexpected:0"),
      runningVerification(secondId, "worker-unexpected:0"),
    ];
    const registry = {
      claimVerification: () => claims.shift() ?? null,
      renewVerificationLease: () => true,
    } as unknown as Pick<
      ModelRegistryStore,
      "claimVerification" | "renewVerificationLease"
    >;
    const failure = new Error("unexpected_verification_failure");
    const safelyFailed: typeof firstId[] = [];
    let secondCompleted = false;
    const verify = {
      async runClaimed(verification: ModelVerification): Promise<ModelVerification> {
        if (verification.verificationId === firstId) throw failure;
        secondCompleted = true;
        return { ...verification, state: "passed" };
      },
      failClaimed(verification: ModelVerification): ModelVerification {
        safelyFailed.push(verification.verificationId);
        return { ...verification, state: "failed" };
      },
    };
    const reported: Array<{ error: unknown; verificationId: typeof firstId }> = [];
    const worker = new ModelVerificationWorker({
      registry,
      verify,
      clock: new SystemClock(),
      workerId: "worker-unexpected",
      idleDelayMs: 5,
      onUnexpectedVerificationError(error, verificationId) {
        reported.push({ error, verificationId });
      },
    });

    worker.start();
    try {
      await waitFor(() => secondCompleted);
    } finally {
      await worker.stop().catch(() => undefined);
    }

    expect(safelyFailed).toEqual([firstId]);
    expect(reported).toEqual([{ error: failure, verificationId: firstId }]);
  });

  it("backs off and retries a transient SQLite busy claim", async () => {
    const verificationId = modelVerificationIdFromUuid("busy-claim");
    const claimed = runningVerification(verificationId, "worker-busy:0");
    let claimCount = 0;
    const registry = {
      claimVerification: () => {
        claimCount += 1;
        if (claimCount === 1) {
          const error = new Error("database is locked") as Error & { errcode: number };
          error.errcode = 5;
          throw error;
        }
        return claimCount === 2 ? claimed : null;
      },
      renewVerificationLease: () => true,
    } as unknown as Pick<
      ModelRegistryStore,
      "claimVerification" | "renewVerificationLease"
    >;
    let completed = false;
    const verify = {
      async runClaimed(verification: ModelVerification): Promise<ModelVerification> {
        completed = true;
        return { ...verification, state: "passed" };
      },
      failClaimed(verification: ModelVerification): ModelVerification {
        return { ...verification, state: "failed" };
      },
    };
    const worker = new ModelVerificationWorker({
      registry,
      verify,
      clock: new SystemClock(),
      workerId: "worker-busy",
      idleDelayMs: 5,
    });

    worker.start();
    try {
      await waitFor(() => completed);
    } finally {
      await worker.stop().catch(() => undefined);
    }

    expect(claimCount).toBeGreaterThanOrEqual(2);
  });

  it("backs off per-job SQLite busy errors without completing the claim", async () => {
    const verificationId = modelVerificationIdFromUuid("busy-job");
    const claimed = runningVerification(verificationId, "worker-busy-job:0");
    let claimedOnce = false;
    let runCount = 0;
    const registry = {
      claimVerification: () => {
        if (claimedOnce) return null;
        claimedOnce = true;
        return claimed;
      },
      renewVerificationLease: () => true,
    } as unknown as Pick<
      ModelRegistryStore,
      "claimVerification" | "renewVerificationLease"
    >;
    const busy = new Error("database is locked") as Error & { errcode: number };
    busy.errcode = 5;
    const completed: typeof verificationId[] = [];
    const delays: number[] = [];
    const verify = {
      async runClaimed(): Promise<ModelVerification> {
        runCount += 1;
        throw busy;
      },
      failClaimed(verification: ModelVerification): ModelVerification {
        completed.push(verification.verificationId);
        return { ...verification, state: "failed" };
      },
    };
    const clock = {
      now: () => new Date(),
      async sleep(milliseconds: number): Promise<void> {
        delays.push(milliseconds);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      },
    };
    const worker = new ModelVerificationWorker({
      registry,
      verify,
      clock,
      workerId: "worker-busy-job",
      idleDelayMs: 5,
    });

    worker.start();
    try {
      await waitFor(() => runCount === 1 && delays.includes(50));
    } finally {
      await worker.stop().catch(() => undefined);
    }

    expect(completed).toEqual([]);
  });

  it("surfaces SQLite-unavailable heartbeat failures as fatal", async () => {
    const verificationId = modelVerificationIdFromUuid("fatal-heartbeat");
    const claimed = runningVerification(verificationId, "worker-fatal-heartbeat:0");
    let started: (() => void) | undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let reportFatal: ((error: unknown) => void) | undefined;
    const fatal = new Promise<unknown>((resolve) => {
      reportFatal = resolve;
    });
    const unavailable = new Error("database is closed") as Error & { code: string };
    unavailable.code = "SQLITE_MISUSE";
    const registry = {
      claimVerification: () => claimed,
      renewVerificationLease: () => {
        throw unavailable;
      },
    } as unknown as Pick<
      ModelRegistryStore,
      "claimVerification" | "renewVerificationLease"
    >;
    const verify = {
      async runClaimed(_verification: ModelVerification, signal: AbortSignal): Promise<ModelVerification> {
        started?.();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        throw new Error("unreachable");
      },
      failClaimed: (verification: ModelVerification) => verification,
    };
    const worker = new ModelVerificationWorker({
      registry,
      verify,
      clock: new SystemClock(),
      workerId: "worker-fatal-heartbeat",
      heartbeatIntervalMs: 5,
      leaseDurationMs: 50,
      idleDelayMs: 5,
      onFatalError(error) {
        reportFatal?.(error);
      },
    });

    worker.start();
    await running;
    await expect(fatal).resolves.toBe(unavailable);
    await expect(worker.stop()).rejects.toBe(unavailable);
  });

  it("aborts on shutdown and reclaims the expired lease after restart", async () => {
    const connection = openDatabase({
      path: tempPath("model-verification-worker-restart.db"),
      busyTimeoutMs: 5_000,
    });
    let firstWorker: ModelVerificationWorker | undefined;
    let restartedWorker: ModelVerificationWorker | undefined;
    try {
      migrate(connection.db);
      const registry = new SqliteModelRegistryRepository(connection.db);
      const clock = new SystemClock();
      const seeded = seedDraftCandidate(registry, clock, "restart");
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let shutdownAborted = false;
      const blockingModel: ModelPort = {
        async *streamAttempt(_request, signal) {
          markStarted?.();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              shutdownAborted = true;
              reject(signal.reason);
            }, { once: true });
          });
          if (signal.aborted) yield { type: "text_delta", text: "unreachable" };
        },
      };
      const firstVerify = new VerifyModelService({
        registry,
        model: blockingModel,
        clock,
        ids: new FakeIds({
          modelVerificationIds: [seeded.verificationId],
          modelRegistryEventIds: [modelRegistryEventIdFromUuid("restart-queue")],
        }),
        requestTimeoutMs: 30_000,
        jobTimeoutMs: 120_000,
      });
      firstVerify.queue({
        profileId: seeded.profileId,
        profileRevisionId: seeded.profileRevisionId,
        expectedRevision: 0,
        traceId: "trace-restart",
      });
      firstWorker = new ModelVerificationWorker({
        registry,
        verify: firstVerify,
        clock,
        workerId: "verification-worker-before-restart",
        leaseDurationMs: 90,
        heartbeatIntervalMs: 30,
        idleDelayMs: 5,
      });

      firstWorker.start();
      await started;
      await firstWorker.stop();
      firstWorker = undefined;

      const interrupted = registry.getVerification(seeded.verificationId);
      expect(shutdownAborted).toBe(true);
      expect(interrupted).toMatchObject({
        state: "running",
        attemptCount: 1,
        leaseOwner: "verification-worker-before-restart:0",
      });
      const expiresAt = interrupted.leaseExpiresAt;
      if (expiresAt === null) throw new Error("expected_running_lease");
      await waitFor(() => Date.now() >= expiresAt.getTime());

      const restartedModel = new ScriptedModel();
      restartedModel.script(completedText("recovered"), {
        chunks: [
          {
            type: "tool_call",
            callId: "provider-restarted-call",
            name: "capability_probe",
            arguments: { nonce: "restart-probe" },
          },
          { type: "completed", finishReason: "tool_call" },
        ],
      });
      const restartedVerify = new VerifyModelService({
        registry,
        model: restartedModel,
        clock,
        ids: new FakeIds({
          modelRegistryEventIds: [modelRegistryEventIdFromUuid("restart-complete")],
        }),
        requestTimeoutMs: 30_000,
        jobTimeoutMs: 120_000,
        createNonce: () => "restart-probe",
      });
      restartedWorker = new ModelVerificationWorker({
        registry,
        verify: restartedVerify,
        clock,
        workerId: "verification-worker-after-restart",
        leaseDurationMs: 90,
        heartbeatIntervalMs: 30,
        idleDelayMs: 5,
      });

      restartedWorker.start();
      await waitFor(() =>
        registry.getVerification(seeded.verificationId).state === "passed"
      );
      await restartedWorker.stop();
      restartedWorker = undefined;

      expect(registry.getVerification(seeded.verificationId)).toMatchObject({
        state: "passed",
        attemptCount: 3,
        leaseOwner: null,
      });
    } finally {
      await firstWorker?.stop().catch(() => undefined);
      await restartedWorker?.stop().catch(() => undefined);
      connection.close();
    }
  });

  it("cancels a running lease and rejects passed or failed terminal work", async () => {
    const connection = openDatabase({
      path: tempPath("model-verification-worker-cancellation.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const registry = new SqliteModelRegistryRepository(connection.db);
      const clock = new SystemClock();
      const running = seedDraftCandidate(registry, clock, "cancel-running");
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const blockingModel: ModelPort = {
        async *streamAttempt(_request, signal) {
          markStarted?.();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          if (signal.aborted) yield { type: "text_delta", text: "unreachable" };
        },
      };
      const verify = new VerifyModelService({
        registry,
        model: blockingModel,
        clock,
        ids: new FakeIds({
          modelVerificationIds: [running.verificationId],
          modelRegistryEventIds: [
            modelRegistryEventIdFromUuid("cancel-running-queue"),
            modelRegistryEventIdFromUuid("cancel-running-commit"),
          ],
        }),
        requestTimeoutMs: 30_000,
        jobTimeoutMs: 120_000,
      });
      verify.queue({
        profileId: running.profileId,
        profileRevisionId: running.profileRevisionId,
        expectedRevision: 0,
        traceId: "trace-cancel-running",
      });
      const claimed = registry.claimVerification({
        leaseOwner: "cancel-owner",
        now: clock.now(),
        leaseUntil: new Date(clock.now().getTime() + 30_000),
      });
      if (claimed === null) throw new Error("expected_claimed_verification");
      const executing = verify.runClaimed(
        claimed,
        new AbortController().signal,
      ).catch((error: unknown) => error);
      await started;
      const current = registry.getVerification(running.verificationId);

      const cancelled = verify.cancel({
        verificationId: running.verificationId,
        expectedRevision: current.recordRevision,
        traceId: "trace-cancel-running",
      });
      await executing;

      expect(cancelled).toMatchObject({
        state: "cancelled",
        leaseOwner: null,
        leaseExpiresAt: null,
        cancellationRequestedAt: expect.any(Date),
      });

      for (const outcome of ["passed", "failed"] as const) {
        const terminal = seedDraftCandidate(registry, clock, `cancel-${outcome}`);
        registry.queueVerification({
          verificationId: terminal.verificationId,
          profileRevisionId: terminal.profileRevisionId,
          expectedRevision: 0,
          capabilityBaseline: "text_and_single_tool_call_v1",
          eventId: modelRegistryEventIdFromUuid(`cancel-${outcome}-queue`),
          traceId: `trace-cancel-${outcome}`,
          now: clock.now(),
        });
        const terminalClaim = registry.claimVerification({
          leaseOwner: `terminal-${outcome}`,
          now: clock.now(),
          leaseUntil: new Date(clock.now().getTime() + 30_000),
        });
        if (terminalClaim === null) throw new Error("expected_terminal_claim");
        const completed = registry.completeVerification({
          verificationId: terminal.verificationId,
          leaseOwner: `terminal-${outcome}`,
          outcome,
          capabilities: outcome === "passed"
            ? ["streaming_text", "single_tool_call"]
            : [],
          ...(outcome === "failed" ? { resultCode: "provider_unavailable" } : {}),
          eventId: modelRegistryEventIdFromUuid(`cancel-${outcome}-complete`),
          traceId: `trace-cancel-${outcome}`,
          now: clock.now(),
        });

        expect(() => registry.cancelVerification({
          verificationId: terminal.verificationId,
          expectedRevision: completed.recordRevision,
          eventId: modelRegistryEventIdFromUuid(`cancel-${outcome}-reject`),
          traceId: `trace-cancel-${outcome}`,
          now: clock.now(),
        })).toThrowError(expect.objectContaining({ code: "verification_terminal" }));
      }
    } finally {
      connection.close();
    }
  });
});

function runningVerification(
  verificationId: ReturnType<typeof modelVerificationIdFromUuid>,
  leaseOwner: string,
): ModelVerification {
  const now = new Date();
  return {
    verificationId,
    profileRevisionId: modelProfileRevisionIdFromUuid(String(verificationId)),
    capabilityBaseline: "text_and_single_tool_call_v1",
    state: "running",
    attemptCount: 0,
    capabilities: [],
    traceId: "trace-worker-unexpected",
    leaseOwner,
    leaseExpiresAt: new Date(now.getTime() + 30_000),
    cancellationRequestedAt: null,
    fallbackVerificationId: null,
    recordRevision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed_out_waiting_for_condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function seedDraftCandidate(
  registry: SqliteModelRegistryRepository,
  clock: SystemClock,
  suffix: string,
): {
  readonly profileId: ReturnType<typeof parseModelProfileId>;
  readonly profileRevisionId: ReturnType<typeof modelProfileRevisionIdFromUuid>;
  readonly verificationId: ReturnType<typeof modelVerificationIdFromUuid>;
} {
  const profileId = parseModelProfileId(`profile-${suffix}`);
  const connectionId = parseProviderConnectionId(`connection-${suffix}`);
  const profileRevisionId = modelProfileRevisionIdFromUuid(suffix);
  const connectionRevisionId = providerConnectionRevisionIdFromUuid(suffix);
  const verificationId = modelVerificationIdFromUuid(suffix);
  registry.createConnection({
    connectionId,
    displayName: `Connection ${suffix}`,
    providerKind: "openai_compatible",
    revision: {
      revisionId: connectionRevisionId,
      connectionId,
      state: "draft",
      baseUrl: "https://example.invalid/v1",
      auth: { type: "none" },
      allowInsecureHttp: false,
      protocolPreference: "chat_completions",
      presetVersion: "custom-v1",
      createdAt: clock.now(),
    },
    eventId: modelRegistryEventIdFromUuid(`create-connection-${suffix}`),
    traceId: `trace-${suffix}`,
    now: clock.now(),
  });
  registry.createProfile({
    profileId,
    displayName: `Profile ${suffix}`,
    revision: {
      revisionId: profileRevisionId,
      profileId,
      connectionRevisionId,
      providerModelId: `model-${suffix}`,
      invocationProtocol: "chat_completions",
      maxInputTokens: 32_768,
      contextWindowSource: "assumed_32768",
      capabilityBaseline: "text_and_single_tool_call_v1",
      verifiedCapabilities: [],
      state: "draft",
      createdAt: clock.now(),
    },
    eventId: modelRegistryEventIdFromUuid(`create-profile-${suffix}`),
    traceId: `trace-${suffix}`,
    now: clock.now(),
  });
  return { profileId, profileRevisionId, verificationId };
}
