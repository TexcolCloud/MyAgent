import { describe, expect, it } from "vitest";

import {
  ValidatedUnsupportedEndpointError,
  VerifyModelService,
} from "../../src/application/verify-model.js";
import { ManageModelProfilesService } from "../../src/application/manage-model-profiles.js";
import type { ModelVerification } from "../../src/domain/model-verification.js";
import {
  modelProfileRevisionIdFromUuid,
  modelRegistryEventIdFromUuid,
  modelVerificationIdFromUuid,
  parseModelProfileId,
  parseProviderConnectionId,
  providerConnectionRevisionIdFromUuid,
} from "../../src/domain/ids.js";
import type { ModelProfileView } from "../../src/domain/model-profile.js";
import type { ProviderConnectionView } from "../../src/domain/provider-connection.js";
import {
  canTryFallback,
  classifyVerificationRetry,
  validateUnsupportedEndpointCode,
} from "../../src/domain/model-verification.js";
import type {
  CompleteVerificationInput,
  QueueLegacyProfileVerificationRecord,
  QueueVerificationRecord,
} from "../../src/ports/model-registry-store.js";
import type { VerifyModelRegistry } from "../../src/application/verify-model.js";
import { ModelProviderError } from "../../src/ports/model.js";
import type { ModelPort } from "../../src/ports/model.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { FakeIds } from "../helpers/fake-ids.js";
import { ScriptedModel, completedText } from "../helpers/scripted-model.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");

describe("VerifyModelService", () => {
  it("queues only the exact draft with the owning Profile revision", () => {
    const fixture = createVerificationFixture({ state: "draft" });

    const queued = fixture.service.queue({
      profileId: fixture.profile.profileId,
      profileRevisionId: fixture.claimed.profileRevisionId,
      expectedRevision: fixture.profile.recordRevision,
      traceId: "trace-queue",
    });

    expect(queued.state).toBe("queued");
    expect(fixture.queued).toMatchObject({
      profileRevisionId: fixture.claimed.profileRevisionId,
      expectedRevision: fixture.profile.recordRevision,
      capabilityBaseline: "text_and_single_tool_call_v1",
      traceId: "trace-queue",
    });
    expect(fixture.legacyQueued).toBeUndefined();
  });

  it("copies a legacy-trusted revision before formal verification", () => {
    const fixture = createVerificationFixture({ state: "legacy_trusted" });
    const legacyRevision = fixture.profile.revisions[0];
    const expectedRevision = fixture.profile.recordRevision;

    const queued = fixture.service.queue({
      profileId: fixture.profile.profileId,
      profileRevisionId: fixture.claimed.profileRevisionId,
      expectedRevision: fixture.profile.recordRevision,
      traceId: "trace-legacy-queue",
    });

    expect(queued.profileRevisionId).not.toBe(legacyRevision?.revisionId);
    expect(fixture.queued).toBeUndefined();
    expect(fixture.legacyQueued).toMatchObject({
      profileId: fixture.profile.profileId,
      legacyProfileRevisionId: legacyRevision?.revisionId,
      candidateRevisionId: queued.profileRevisionId,
      verificationId: queued.verificationId,
      expectedRevision,
      traceId: "trace-legacy-queue",
    });
    expect(fixture.profile.revisions).toEqual([
      expect.objectContaining({
        revisionId: legacyRevision?.revisionId,
        state: "legacy_trusted",
      }),
      expect.objectContaining({
        revisionId: queued.profileRevisionId,
        state: "verifying",
        providerModelId: legacyRevision?.providerModelId,
        invocationProtocol: legacyRevision?.invocationProtocol,
      }),
    ]);
    expect(fixture.profile.recordRevision).toBe(expectedRevision + 1);
  });

  it("passes only after streamed text and one synthetic Tool Call", async () => {
    const fixture = createVerificationFixture();
    fixture.model.script(
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
    await fixture.service.runClaimed(
      fixture.claimed,
      new AbortController().signal,
    );

    expect(fixture.completed).toMatchObject({
      outcome: "passed",
      capabilities: ["streaming_text", "single_tool_call"],
    });
    expect(fixture.model.requests.map(({ purpose, tools, toolChoice }) => ({
      purpose,
      tools,
      toolChoice,
    }))).toEqual([
      { purpose: "verification_text", tools: [], toolChoice: undefined },
      {
        purpose: "verification_tool",
        tools: [expect.objectContaining({ name: "capability_probe" })],
        toolChoice: "required",
      },
    ]);
  });

  it.each([
    {
      name: "text",
      resultCode: "streaming_unsupported",
      scripts: [{
        chunks: [
          { type: "text_delta" as const, text: "ok" },
          { type: "completed" as const, finishReason: "completed" as const },
          { type: "text_delta" as const, text: "after-terminal" },
        ],
      }],
    },
    {
      name: "tool",
      resultCode: "tool_call_unsupported",
      scripts: [
        completedText("ok"),
        {
          chunks: [
            {
              type: "tool_call" as const,
              callId: "provider-call",
              name: "capability_probe",
              arguments: { nonce: "probe" },
            },
            { type: "completed" as const, finishReason: "tool_call" as const },
            { type: "text_delta" as const, text: "after-terminal" },
          ],
        },
      ],
    },
  ])("rejects every stream chunk after terminal completion for the $name probe", async ({ scripts, resultCode }) => {
    const fixture = createVerificationFixture();
    fixture.model.script(...scripts);

    await fixture.service.runClaimed(fixture.claimed, new AbortController().signal);

    expect(fixture.completed).toMatchObject({
      outcome: "failed",
      resultCode,
    });
  });

  it.each([
    "provider-call\nnewline",
    "x".repeat(201),
  ])("rejects non-printable or oversized provider tool call IDs", async (callId) => {
    const fixture = createVerificationFixture();
    fixture.model.script(completedText("ok"), {
      chunks: [
        {
          type: "tool_call",
          callId,
          name: "capability_probe",
          arguments: { nonce: "probe" },
        },
        { type: "completed", finishReason: "tool_call" },
      ],
    });

    await fixture.service.runClaimed(fixture.claimed, new AbortController().signal);

    expect(fixture.completed).toMatchObject({
      outcome: "failed",
      resultCode: "tool_call_unsupported",
    });
  });

  it("propagates unknown runtime failures to worker supervision", async () => {
    const fixture = createVerificationFixture();
    const failure = new Error("registry_transport_failed");
    fixture.registry.beginVerificationAttempt = () => {
      throw failure;
    };

    await expect(
      fixture.service.runClaimed(fixture.claimed, new AbortController().signal),
    ).rejects.toBe(failure);

    expect(fixture.completed).toBeUndefined();
  });

  it("honors a parent abort that occurs while an attempt is being prepared", async () => {
    const fixture = createVerificationFixture();
    const parent = new AbortController();
    fixture.registry.beginVerificationAttempt = () => {
      parent.abort(new Error("abort_during_registration"));
      return fixture.claimed;
    };
    fixture.model.script(completedText("should-not-run"));

    await expect(fixture.service.runClaimed(fixture.claimed, parent.signal))
      .rejects.toThrow("abort_during_registration");

    expect(fixture.model.requests).toEqual([]);
    expect(fixture.completed).toBeUndefined();
  });

  it("aborts a probe at the configured request timeout", async () => {
    const fixture = createVerificationFixture();
    const blockingModel: ModelPort = {
      async *streamAttempt(_request, signal) {
        await new Promise<void>((_resolve, reject) => {
          const onAbort = (): void => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
        });
        if (signal.aborted) yield { type: "text_delta", text: "unreachable" };
      },
    };
    const service = new VerifyModelService({
      registry: fixture.registry,
      model: blockingModel,
      clock: new FakeClock(NOW),
      ids: new FakeIds({
        modelRegistryEventIds: [modelRegistryEventIdFromUuid("timeout")],
      }),
      requestTimeoutMs: 10,
      jobTimeoutMs: 100,
    });
    const external = new AbortController();

    const outcome = await Promise.race([
      service.runClaimed(fixture.claimed, external.signal).then(() => "completed"),
      new Promise<"still-running">((resolve) => {
        setTimeout(() => resolve("still-running"), 50);
      }),
    ]);
    if (outcome === "still-running") external.abort(new Error("test-cleanup"));

    expect(outcome).toBe("completed");
    expect(fixture.completed).toMatchObject({
      outcome: "failed",
      resultCode: "provider_unavailable",
    });
  });

  it("retries when an adapter normalizes a bounded timeout to AbortError", async () => {
    const fixture = createVerificationFixture();
    const attempts: string[] = [];
    const model: ModelPort = {
      async *streamAttempt(request, signal) {
        attempts.push(request.purpose);
        if (request.purpose === "verification_text" && attempts.length === 1) {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(new DOMException("adapter normalized timeout", "AbortError"));
            }, { once: true });
          });
        }
        if (request.purpose === "verification_text") {
          yield { type: "text_delta", text: "retried" };
          yield { type: "completed", finishReason: "completed" };
          return;
        }
        yield {
          type: "tool_call",
          callId: "provider-call",
          name: "capability_probe",
          arguments: { nonce: "probe" },
        };
        yield { type: "completed", finishReason: "tool_call" };
      },
    };
    const service = new VerifyModelService({
      registry: fixture.registry,
      model,
      clock: new FakeClock(NOW),
      ids: new FakeIds({
        modelRegistryEventIds: [modelRegistryEventIdFromUuid("timeout-retry")],
      }),
      requestTimeoutMs: 10,
      jobTimeoutMs: 3_000,
      createNonce: () => "probe",
    });

    await service.runClaimed(fixture.claimed, new AbortController().signal);

    expect(attempts).toEqual([
      "verification_text",
      "verification_text",
      "verification_tool",
    ]);
    expect(fixture.completed).toMatchObject({ outcome: "passed" });
  });

  it("completes an exhausted normalized timeout as provider unavailable", async () => {
    const fixture = createVerificationFixture();
    const attempts: string[] = [];
    const model: ModelPort = {
      async *streamAttempt(request, signal) {
        attempts.push(request.purpose);
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("adapter normalized timeout", "AbortError"));
          }, { once: true });
        });
        if (signal.aborted) yield { type: "text_delta", text: "unreachable" };
      },
    };
    const service = new VerifyModelService({
      registry: fixture.registry,
      model,
      clock: new FakeClock(NOW),
      ids: new FakeIds({
        modelRegistryEventIds: [modelRegistryEventIdFromUuid("timeout-exhausted")],
      }),
      requestTimeoutMs: 10,
      jobTimeoutMs: 3_000,
    });

    await service.runClaimed(fixture.claimed, new AbortController().signal);

    expect(attempts).toEqual(["verification_text", "verification_text"]);
    expect(fixture.completed).toMatchObject({
      outcome: "failed",
      resultCode: "provider_unavailable",
    });
  });

  it("cancels a running Verification and aborts its in-flight probe", async () => {
    const fixture = createVerificationFixture();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let sawAbort = false;
    const blockingModel: ModelPort = {
      async *streamAttempt(_request, signal) {
        markStarted?.();
        await new Promise<void>((_resolve, reject) => {
          const onAbort = (): void => {
            sawAbort = true;
            reject(signal.reason);
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });
        if (signal.aborted) yield { type: "text_delta", text: "unreachable" };
      },
    };
    const service = new VerifyModelService({
      registry: fixture.registry,
      model: blockingModel,
      clock: new FakeClock(NOW),
      ids: new FakeIds({
        modelRegistryEventIds: [modelRegistryEventIdFromUuid("cancel")],
      }),
      requestTimeoutMs: 30_000,
      jobTimeoutMs: 120_000,
    });
    const running = service.runClaimed(
      fixture.claimed,
      new AbortController().signal,
    ).catch((error: unknown) => error);
    await started;

    const cancelled = service.cancel({
      verificationId: fixture.claimed.verificationId,
      expectedRevision: fixture.claimed.recordRevision,
      traceId: "trace-cancel",
    });

    await running;
    expect(cancelled.state).toBe("cancelled");
    expect(sawAbort).toBe(true);
    expect(fixture.completed).toBeUndefined();
  });

  it.each([401, 429, 500])(
    "does not protocol-fallback after HTTP %i",
    async (status) => {
      const fixture = createVerificationFixture();
      const code = status === 401
        ? "provider_auth_failed"
        : status === 429
          ? "provider_rate_limited"
          : "provider_unavailable";
      const failure = (): { chunks: []; error: ModelProviderError } => ({
        chunks: [],
        error: new ModelProviderError({
          code,
          transient: status !== 401,
          status,
        }),
      });
      fixture.model.script(failure(), failure());

      await fixture.service.runClaimed(
        fixture.claimed,
        new AbortController().signal,
      );

      expect(fixture.completed).toMatchObject({
        outcome: "failed",
        resultCode: code,
        safeStatus: status,
      });
      expect(fixture.profile.revisions).toHaveLength(1);
    },
  );

  it("atomically queues one fallback candidate after preferred endpoint absence", async () => {
    const fixture = createVerificationFixture();
    fixture.model.script({
      chunks: [],
      error: new ModelProviderError({
        code: "invocation_protocol_unsupported",
        transient: false,
        status: 404,
      }),
    });

    await fixture.service.runClaimed(
      fixture.claimed,
      new AbortController().signal,
    );

    expect(fixture.completed).toMatchObject({
      outcome: "failed",
      resultCode: "invocation_protocol_unsupported",
      safeStatus: 404,
      fallback: {
        revision: {
          state: "draft",
          invocationProtocol: "responses",
          providerModelId: "model-a",
          verifiedCapabilities: [],
        },
        verification: {
          capabilityBaseline: "text_and_single_tool_call_v1",
          expectedRevision: 1,
        },
      },
    });
    expect(fixture.profile.revisions).toHaveLength(2);
  });

  it.each([404, 405, 501])(
    "canonicalizes adapter-normalized endpoint absence HTTP %i for fallback",
    async (status) => {
      const fixture = createVerificationFixture();
      fixture.model.script({
        chunks: [],
        error: new ModelProviderError({
          code: "model_protocol_error",
          transient: false,
          status,
        }),
      });

      await fixture.service.runClaimed(
        fixture.claimed,
        new AbortController().signal,
      );

      expect(fixture.completed).toMatchObject({
        outcome: "failed",
        resultCode: "invocation_protocol_unsupported",
        safeStatus: status,
        fallback: expect.any(Object),
      });
      expect(fixture.profile.revisions).toHaveLength(2);
    },
  );

  it.each([404, 405, 501])(
    "does not treat unknown provider code at HTTP %i as endpoint absence",
    async (status) => {
      const fixture = createVerificationFixture();
      fixture.model.script({
        chunks: [],
        error: new ModelProviderError({
          code: "provider_made_up",
          transient: false,
          status,
        }),
      });

      await fixture.service.runClaimed(
        fixture.claimed,
        new AbortController().signal,
      );

      expect(fixture.completed).toMatchObject({
        outcome: "failed",
        resultCode: "model_protocol_error",
        safeStatus: status,
      });
      expect(fixture.completed?.fallback).toBeUndefined();
      expect(fixture.profile.revisions).toHaveLength(1);
    },
  );

  it("uses trusted unsupported-endpoint evidence without persisting it", async () => {
    const fixture = createVerificationFixture();
    const evidence = validateUnsupportedEndpointCode("unsupported_endpoint");
    if (evidence === null) throw new Error("expected_validated_evidence");
    fixture.model.script({
      chunks: [],
      error: new ValidatedUnsupportedEndpointError(evidence),
    });

    await fixture.service.runClaimed(
      fixture.claimed,
      new AbortController().signal,
    );

    expect(fixture.completed).toMatchObject({
      outcome: "failed",
      resultCode: "invocation_protocol_unsupported",
      fallback: expect.any(Object),
    });
    expect(JSON.stringify(fixture.completed)).not.toContain("unsupported_endpoint");
  });
});

describe("ManageModelProfilesService", () => {
  it("creates a stable Profile with one immutable draft revision", () => {
    const profileId = parseModelProfileId("managed-profile");
    const connectionRevisionId = providerConnectionRevisionIdFromUuid("managed");
    let created: Parameters<VerifyModelRegistry["createProfile"]>[0] | undefined;
    const registry = {
      createProfile(input: NonNullable<typeof created>) {
        created = input;
        return {
          profileId,
          displayName: input.displayName,
          activeRevisionId: null,
          retiredAt: null,
          recordRevision: 0,
          revisions: [input.revision],
        };
      },
      createProfileRevision: () => {
        throw new Error("not_used");
      },
      getProfile: () => {
        throw new Error("not_used");
      },
      promoteProfile: () => {
        throw new Error("not_used");
      },
      purgeProfile: () => undefined,
      retireProfile: () => {
        throw new Error("not_used");
      },
    };
    const service = new ManageModelProfilesService(
      registry,
      new FakeClock(NOW),
      new FakeIds({
        modelProfileRevisionIds: [modelProfileRevisionIdFromUuid("managed")],
        modelRegistryEventIds: [modelRegistryEventIdFromUuid("managed-create")],
      }),
    );

    const profile = service.create({
      profileId,
      displayName: "Managed Profile",
      connectionRevisionId,
      providerModelId: "managed-model",
      invocationProtocol: "responses",
      maxInputTokens: 64_000,
      contextWindowSource: "operator",
      traceId: "trace-managed",
    });

    expect(profile.revisions).toEqual([
      expect.objectContaining({
        profileId,
        connectionRevisionId,
        providerModelId: "managed-model",
        invocationProtocol: "responses",
        state: "draft",
        verifiedCapabilities: [],
      }),
    ]);
    expect(created).toMatchObject({ displayName: "Managed Profile" });
  });
});

function createVerificationFixture(options: {
  readonly state?: "draft" | "verifying" | "legacy_trusted";
} = {}): {
  readonly claimed: ModelVerification;
  readonly completed: CompleteVerificationInput | undefined;
  readonly legacyQueued: QueueLegacyProfileVerificationRecord | undefined;
  readonly model: ScriptedModel;
  readonly profile: ModelProfileView;
  readonly queued: QueueVerificationRecord | undefined;
  readonly registry: VerifyModelRegistry;
  readonly service: VerifyModelService;
} {
  const profileId = parseModelProfileId("profile-a");
  const connectionId = parseProviderConnectionId("connection-a");
  const profileRevisionId = modelProfileRevisionIdFromUuid("candidate");
  const connectionRevisionId = providerConnectionRevisionIdFromUuid("candidate");
  const verificationId = modelVerificationIdFromUuid("candidate");
  const claimed: ModelVerification = {
    verificationId,
    profileRevisionId,
    capabilityBaseline: "text_and_single_tool_call_v1",
    state: "running",
    attemptCount: 0,
    capabilities: [],
    traceId: "trace-verification",
    leaseOwner: "worker-a",
    leaseExpiresAt: new Date("2026-08-09T00:05:00.000Z"),
    cancellationRequestedAt: null,
    fallbackVerificationId: null,
    recordRevision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const profile: ModelProfileView = {
    profileId,
    displayName: "Profile A",
    activeRevisionId: null,
    retiredAt: null,
    recordRevision: 1,
    revisions: [{
      revisionId: profileRevisionId,
      profileId,
      connectionRevisionId,
      providerModelId: "model-a",
      invocationProtocol: "chat_completions",
      maxInputTokens: 32_768,
      contextWindowSource: "assumed_32768",
      capabilityBaseline: "text_and_single_tool_call_v1",
      verifiedCapabilities: [],
      state: options.state ?? "verifying",
      createdAt: NOW,
    }],
  };
  const connection: ProviderConnectionView = {
    connectionId,
    displayName: "Connection A",
    providerKind: "openai_compatible",
    activeRevisionId: null,
    retiredAt: null,
    recordRevision: 0,
    revisions: [{
      revisionId: connectionRevisionId,
      connectionId,
      state: "draft",
      baseUrl: "https://example.invalid/v1",
      auth: { type: "none" },
      allowInsecureHttp: false,
      protocolPreference: "chat_completions",
      presetVersion: "custom-v1",
      createdAt: NOW,
    }],
  };
  let completed: CompleteVerificationInput | undefined;
  let legacyQueued: QueueLegacyProfileVerificationRecord | undefined;
  let queued: QueueVerificationRecord | undefined;
  const profileRevisions = [...profile.revisions];
  const mutableProfile: ModelProfileView = { ...profile, revisions: profileRevisions };
  const registry: VerifyModelRegistry = {
    createProfile: () => mutableProfile,
    createProfileRevision: (input) => {
      profileRevisions.push(input.revision);
      (mutableProfile as { recordRevision: number }).recordRevision += 1;
      return mutableProfile;
    },
    getProfile: () => mutableProfile,
    listProfiles: () => [mutableProfile],
    promoteProfile: () => mutableProfile,
    purgeProfile: () => undefined,
    retireProfile: () => mutableProfile,
    listConnections: () => [connection],
    beginVerificationAttempt: () => claimed,
    completeVerification: (input) => {
      completed = input;
      if (input.fallback !== undefined) {
        profileRevisions.push(input.fallback.revision);
      }
      return { ...claimed, state: input.outcome, capabilities: input.capabilities };
    },
    queueLegacyProfileVerification: (input) => {
      legacyQueued = input;
      const legacyRevision = profileRevisions.find(
        (revision) => revision.revisionId === input.legacyProfileRevisionId,
      );
      if (legacyRevision === undefined) throw new Error("legacy_revision_not_found");
      profileRevisions.push({
        ...legacyRevision,
        revisionId: input.candidateRevisionId,
        state: "verifying",
        verifiedCapabilities: [],
        createdAt: input.now,
      });
      (mutableProfile as { recordRevision: number }).recordRevision += 1;
      return {
        ...claimed,
        verificationId: input.verificationId,
        profileRevisionId: input.candidateRevisionId,
        state: "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
      };
    },
    queueVerification: (input) => {
      queued = input;
      const revisionIndex = profileRevisions.findIndex(
        (revision) => revision.revisionId === input.profileRevisionId,
      );
      if (revisionIndex >= 0) {
        const revision = profileRevisions[revisionIndex];
        if (revision !== undefined) {
          profileRevisions[revisionIndex] = { ...revision, state: "verifying" };
        }
      }
      return {
        ...claimed,
        profileRevisionId: input.profileRevisionId,
        state: "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
      };
    },
    cancelVerification: () => ({
      ...claimed,
      state: "cancelled",
      leaseOwner: null,
      leaseExpiresAt: null,
      cancellationRequestedAt: NOW,
    }),
    getVerification: () => claimed,
  };
  const model = new ScriptedModel();
  const service = new VerifyModelService({
    registry,
    model,
    clock: new FakeClock(NOW),
    ids: new FakeIds({
      modelProfileRevisionIds: [modelProfileRevisionIdFromUuid("fallback")],
      modelVerificationIds: [modelVerificationIdFromUuid("fallback")],
      modelRegistryEventIds: [
        modelRegistryEventIdFromUuid("complete"),
        modelRegistryEventIdFromUuid("fallback"),
      ],
    }),
    requestTimeoutMs: 30_000,
    jobTimeoutMs: 120_000,
    createNonce: () => "probe",
  });
  return {
    claimed,
    get completed() {
      return completed;
    },
    get legacyQueued() {
      return legacyQueued;
    },
    model,
    profile: mutableProfile,
    get queued() {
      return queued;
    },
    registry,
    service,
  };
}

describe("Model verification error policy", () => {
  it("allows fallback only for endpoint absence", () => {
    expect(canTryFallback({ status: 404, code: "invocation_protocol_unsupported" })).toBe(true);
    expect(canTryFallback({ status: 401, code: "provider_auth_failed" })).toBe(false);
    expect(canTryFallback({ status: 429, code: "provider_rate_limited" })).toBe(false);
    expect(canTryFallback({ status: 404, code: "provider_auth_failed" })).toBe(false);
    expect(canTryFallback({ status: 405, code: "provider_rate_limited" })).toBe(false);
    expect(canTryFallback({ status: 501, code: "provider_unavailable" })).toBe(false);
  });

  it("requires validated internal evidence for an unsupported endpoint", () => {
    const evidence = validateUnsupportedEndpointCode("unsupported_endpoint");

    expect(evidence).not.toBeNull();
    if (evidence !== null) {
      expect(canTryFallback(evidence)).toBe(true);
    }
    expect(validateUnsupportedEndpointCode("provider_auth_failed")).toBeNull();
  });

  it("accepts only normalized provider/runtime error codes", () => {
    // @ts-expect-error Arbitrary provider codes cannot be used as fallback evidence.
    expect(canTryFallback({ status: 404, code: "provider_made_up" })).toBe(false);
  });

  void (() => {
    // @ts-expect-error Plain endpoint strings are not validated fallback evidence.
    canTryFallback({ code: "unsupported_endpoint" });
  });

  it("retries only the two transient provider failures before the attempt cap", () => {
    expect(classifyVerificationRetry({ transient: true, code: "provider_unavailable" }, 1)).toEqual({
      shouldRetry: true,
      delayMs: 1_000,
    });
    expect(classifyVerificationRetry({ transient: true, code: "provider_rate_limited", retryAfterMs: 31_000 }, 1)).toEqual({
      shouldRetry: true,
      delayMs: 30_000,
    });
    expect(classifyVerificationRetry({ transient: true, code: "provider_auth_failed" }, 1)).toEqual({
      shouldRetry: false,
    });
    expect(classifyVerificationRetry({ transient: true, code: "provider_unavailable" }, 2)).toEqual({
      shouldRetry: false,
    });
  });
});
