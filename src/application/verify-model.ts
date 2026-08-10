import { randomUUID } from "node:crypto";

import type { EffectiveModelRuntime } from "../domain/agent-revision.js";
import {
  DomainError,
  PROVIDER_RUNTIME_ERROR_CODES,
  type ProviderRuntimeErrorCode,
} from "../domain/errors.js";
import {
  canTryFallback,
  classifyVerificationRetry,
  type ModelVerification,
  type ValidatedUnsupportedEndpointEvidence,
} from "../domain/model-verification.js";
import type { ModelProfileRevision, ModelProfileView } from "../domain/model-profile.js";
import type { ProviderConnectionRevision, ProviderConnectionView } from "../domain/provider-connection.js";
import type { Clock } from "../ports/clock.js";
import type { IdGenerator } from "../ports/id-generator.js";
import {
  ModelProviderError,
  type ModelChunk,
  type ModelPort,
  type ModelRequest,
  type ModelUsage,
} from "../ports/model.js";
import type {
  CompleteVerificationInput,
  ModelRegistryStore,
} from "../ports/model-registry-store.js";
import {
  ManageModelProfilesService,
  type PrepareVerificationCandidateInput,
} from "./manage-model-profiles.js";

const TEXT_PROBE_PROMPT = "Reply with a short, harmless greeting.";
const TOOL_PROBE_NAME = "capability_probe";
const TOOL_PROBE_DESCRIPTION = "Return the supplied verification nonce.";

export type VerifyModelRegistry = Pick<
  ModelRegistryStore,
  | "beginVerificationAttempt"
  | "cancelVerification"
  | "completeVerification"
  | "createProfile"
  | "createProfileRevision"
  | "getVerification"
  | "getProfile"
  | "listConnections"
  | "listProfiles"
  | "promoteProfile"
  | "purgeProfile"
  | "queueLegacyProfileVerification"
  | "queueVerification"
  | "retireProfile"
>;

export interface VerifyModelServiceOptions {
  readonly registry: VerifyModelRegistry;
  readonly model: ModelPort;
  readonly clock: Clock;
  readonly ids: Pick<
    IdGenerator,
    | "modelProfileRevisionId"
    | "modelRegistryEventId"
    | "modelVerificationId"
  >;
  readonly requestTimeoutMs: number;
  readonly jobTimeoutMs: number;
  readonly createNonce?: () => string;
}

export interface CancelModelVerificationInput {
  readonly verificationId: ModelVerification["verificationId"];
  readonly expectedRevision: number;
  readonly traceId: string;
}

export class ValidatedUnsupportedEndpointError extends Error {
  constructor(
    readonly evidence: ValidatedUnsupportedEndpointEvidence,
  ) {
    super("invocation_protocol_unsupported");
    this.name = "ValidatedUnsupportedEndpointError";
  }
}

interface ProbeResult {
  readonly usage?: ModelUsage;
}

interface SafeProbeFailure {
  readonly code: ProviderRuntimeErrorCode;
  readonly status?: number;
  readonly unsupportedEndpoint?: ValidatedUnsupportedEndpointEvidence;
}

interface VerificationTarget {
  readonly profile: ModelProfileView;
  readonly profileRevision: ModelProfileRevision;
  readonly connection: ProviderConnectionView;
  readonly connectionRevision: ProviderConnectionRevision;
}

export class VerifyModelService {
  private readonly createNonce: () => string;
  private readonly profiles: ManageModelProfilesService;
  private readonly active = new Map<
    ModelVerification["verificationId"],
    AbortController
  >();

  constructor(private readonly options: VerifyModelServiceOptions) {
    assertPositiveMilliseconds(options.requestTimeoutMs);
    assertPositiveMilliseconds(options.jobTimeoutMs);
    this.createNonce = options.createNonce ?? randomUUID;
    this.profiles = new ManageModelProfilesService(
      options.registry,
      options.clock,
      options.ids,
    );
  }

  queue(input: PrepareVerificationCandidateInput): ModelVerification {
    const candidate = this.profiles.prepareVerificationCandidate(input);
    const now = this.options.clock.now();
    const verificationId = this.options.ids.modelVerificationId();
    if (candidate.kind === "legacy_copy") {
      return this.options.registry.queueLegacyProfileVerification({
        profileId: input.profileId,
        legacyProfileRevisionId: candidate.legacyProfileRevisionId,
        candidateRevisionId: candidate.candidateRevisionId,
        verificationId,
        verificationEventId: this.options.ids.modelRegistryEventId(),
        expectedRevision: candidate.expectedRevision,
        eventId: this.options.ids.modelRegistryEventId(),
        traceId: input.traceId,
        now,
      });
    }
    return this.options.registry.queueVerification({
      verificationId,
      profileRevisionId: candidate.revision.revisionId,
      expectedRevision: candidate.expectedRevision,
      capabilityBaseline: candidate.revision.capabilityBaseline,
      eventId: this.options.ids.modelRegistryEventId(),
      traceId: input.traceId,
      now,
    });
  }

  cancel(input: CancelModelVerificationInput): ModelVerification {
    const cancelled = this.options.registry.cancelVerification({
      verificationId: input.verificationId,
      expectedRevision: input.expectedRevision,
      eventId: this.options.ids.modelRegistryEventId(),
      traceId: input.traceId,
      now: this.options.clock.now(),
    });
    this.active.get(input.verificationId)?.abort(
      new DOMException("The verification was cancelled", "AbortError"),
    );
    return cancelled;
  }

  failClaimed(
    claimed: ModelVerification,
    code: ProviderRuntimeErrorCode = "provider_unavailable",
  ): ModelVerification {
    if (claimed.state !== "running" || claimed.leaseOwner === null) {
      throw new DomainError("verification_lease_lost");
    }
    return this.complete(claimed, {
      outcome: "failed",
      capabilities: claimed.capabilities,
      resultCode: code,
    });
  }

  async runClaimed(
    claimed: ModelVerification,
    signal: AbortSignal,
  ): Promise<ModelVerification> {
    if (
      claimed.state !== "running" ||
      claimed.leaseOwner === null ||
      claimed.leaseExpiresAt === null
    ) {
      throw new DomainError("verification_lease_lost");
    }
    if (this.active.has(claimed.verificationId)) {
      throw new Error("verification_already_running");
    }
    const linked = linkedAbortController(signal);
    this.active.set(claimed.verificationId, linked.controller);
    try {
      return await this.runOwnedClaim(claimed, linked.controller.signal);
    } finally {
      linked.dispose();
      if (this.active.get(claimed.verificationId) === linked.controller) {
        this.active.delete(claimed.verificationId);
      }
    }
  }

  private async runOwnedClaim(
    claimed: ModelVerification,
    signal: AbortSignal,
  ): Promise<ModelVerification> {
    signal.throwIfAborted();
    const model = this.resolveRuntime(claimed.profileRevisionId);
    const deadline = new Date(this.options.clock.now().getTime() + this.options.jobTimeoutMs);
    const capabilities: Array<"streaming_text" | "single_tool_call"> = [];
    let usage: ModelUsage | undefined;
    try {
      const text = await this.runTextProbe(claimed, model, deadline, signal);
      capabilities.push("streaming_text");
      usage = addUsage(usage, text.usage);
      const tool = await this.runToolProbe(claimed, model, deadline, signal);
      capabilities.push("single_tool_call");
      usage = addUsage(usage, tool.usage);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const failure = safeProbeFailure(error);
      if (failure === undefined) throw error;
      const fallback = this.createFallback(claimed, failure);
      return this.complete(claimed, {
        outcome: "failed",
        capabilities,
        resultCode: failure.code,
        ...(failure.status === undefined ? {} : { safeStatus: failure.status }),
        ...(usage === undefined ? {} : { usage }),
        ...(fallback === undefined ? {} : { fallback }),
      });
    }
    return this.complete(claimed, {
      outcome: "passed",
      capabilities,
      ...(usage === undefined ? {} : { usage }),
    });
  }

  private complete(
    claimed: ModelVerification,
    result: Pick<
      CompleteVerificationInput,
      | "capabilities"
      | "fallback"
      | "outcome"
      | "resultCode"
      | "safeStatus"
      | "usage"
    >,
  ): ModelVerification {
    const completion: CompleteVerificationInput = {
      verificationId: claimed.verificationId,
      leaseOwner: claimed.leaseOwner ?? "",
      ...result,
      eventId: this.options.ids.modelRegistryEventId(),
      traceId: claimed.traceId,
      now: this.options.clock.now(),
    };
    return this.options.registry.completeVerification(completion);
  }

  private async runTextProbe(
    claimed: ModelVerification,
    model: EffectiveModelRuntime,
    deadline: Date,
    signal: AbortSignal,
  ): Promise<ProbeResult> {
    const request: ModelRequest = {
      purpose: "verification_text",
      model,
      input: [{ type: "message", role: "user", content: TEXT_PROBE_PROMPT }],
      tools: [],
    };
    return this.withRetries(claimed, deadline, signal, async (attemptSignal) => {
      return this.consumeTextProbe(request, attemptSignal);
    });
  }

  private async consumeTextProbe(
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ProbeResult> {
    let sawText = false;
    let completed = false;
    let usage: ModelUsage | undefined;
    for await (const chunk of this.options.model.streamAttempt(request, signal)) {
      if (completed) throw new DomainError("streaming_unsupported");
      if (chunk.type === "text_delta") {
        if (chunk.text.length > 0) sawText = true;
        continue;
      }
      if (chunk.type !== "completed" || chunk.finishReason !== "completed") {
        throw new DomainError("streaming_unsupported");
      }
      completed = true;
      usage = chunk.usage;
    }
    if (!sawText || !completed) throw new DomainError("streaming_unsupported");
    return usage === undefined ? {} : { usage };
  }

  private async runToolProbe(
    claimed: ModelVerification,
    model: EffectiveModelRuntime,
    deadline: Date,
    signal: AbortSignal,
  ): Promise<ProbeResult> {
    const nonce = this.createNonce();
    const request: ModelRequest = {
      purpose: "verification_tool",
      model,
      input: [{
        type: "message",
        role: "user",
        content: `Call ${TOOL_PROBE_NAME} with nonce ${nonce}.`,
      }],
      tools: [{
        name: TOOL_PROBE_NAME,
        description: TOOL_PROBE_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: { nonce: { type: "string" } },
          required: ["nonce"],
          additionalProperties: false,
        },
      }],
      toolChoice: "required",
    };
    return this.withRetries(claimed, deadline, signal, async (attemptSignal) => {
      return this.consumeToolProbe(request, nonce, attemptSignal);
    });
  }

  private async consumeToolProbe(
    request: ModelRequest,
    nonce: string,
    signal: AbortSignal,
  ): Promise<ProbeResult> {
    let callCount = 0;
    let validCall = false;
    let completed = false;
    let usage: ModelUsage | undefined;
    for await (const chunk of this.options.model.streamAttempt(request, signal)) {
      if (completed) throw new DomainError("tool_call_unsupported");
      if (chunk.type === "tool_call") {
        callCount += 1;
        validCall = isValidProbeCall(chunk, nonce);
        continue;
      }
      if (chunk.type === "text_delta") continue;
      if (chunk.finishReason !== "tool_call") {
        throw new DomainError("tool_call_unsupported");
      }
      completed = true;
      usage = chunk.usage;
    }
    if (callCount !== 1 || !validCall || !completed) {
      throw new DomainError("tool_call_unsupported");
    }
    return usage === undefined ? {} : { usage };
  }

  private async withRetries<T>(
    claimed: ModelVerification,
    deadline: Date,
    signal: AbortSignal,
    attempt: (attemptSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    for (let attemptNumber = 1; attemptNumber <= 2; attemptNumber += 1) {
      signal.throwIfAborted();
      if (this.options.clock.now() >= deadline) {
        throw new ModelProviderError({
          code: "provider_unavailable",
          transient: true,
        });
      }
      this.beginAttempt(claimed);
      const remainingMs = deadline.getTime() - this.options.clock.now().getTime();
      const bounded = boundedAbortSignal(
        signal,
        Math.min(this.options.requestTimeoutMs, remainingMs),
      );
      try {
        return await attempt(bounded.signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        const adapterProviderError = findProviderError(error);
        const providerError = adapterProviderError ??
          (bounded.signal.aborted
            ? findProviderError(bounded.signal.reason)
            : undefined);
        if (providerError === undefined) throw error;
        const errorForPropagation = adapterProviderError === undefined
          ? bounded.signal.reason
          : error;
        const code = normalizedProviderCode(providerError.code);
        const retry = classifyVerificationRetry({
          code,
          transient: providerError.transient,
          ...(providerError.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: providerError.retryAfterMs }),
        }, attemptNumber);
        if (!retry.shouldRetry) throw errorForPropagation;
        const retryBudgetMs = deadline.getTime() - this.options.clock.now().getTime();
        if (retry.delayMs >= retryBudgetMs) {
          throw new ModelProviderError({
            code: "provider_unavailable",
            transient: true,
          });
        }
        await this.options.clock.sleep(retry.delayMs, signal);
      } finally {
        bounded.dispose();
      }
    }
    throw new Error("verification_attempt_limit_unreachable");
  }

  private beginAttempt(claimed: ModelVerification): void {
    this.options.registry.beginVerificationAttempt({
      verificationId: claimed.verificationId,
      leaseOwner: claimed.leaseOwner ?? "",
      now: this.options.clock.now(),
    });
  }

  private resolveRuntime(
    profileRevisionId: ModelVerification["profileRevisionId"],
  ): EffectiveModelRuntime {
    const { profileRevision, connection, connectionRevision } =
      this.resolveTarget(profileRevisionId);
    return Object.freeze({
      providerConnectionRevisionId: connectionRevision.revisionId,
      providerKind: connection.providerKind,
      baseUrl: connectionRevision.baseUrl,
      providerAuth: connectionRevision.auth,
      modelId: profileRevision.providerModelId,
      invocationProtocol: profileRevision.invocationProtocol,
      maxInputTokens: profileRevision.maxInputTokens,
      verifiedCapabilities: Object.freeze([...profileRevision.verifiedCapabilities]),
      compatibilityPresetVersion: connectionRevision.presetVersion,
    });
  }

  private createFallback(
    claimed: ModelVerification,
    failure: SafeProbeFailure,
  ): CompleteVerificationInput["fallback"] | undefined {
    const fallbackAllowed = failure.unsupportedEndpoint === undefined
      ? canTryFallback({
          code: failure.code,
          ...(failure.status === undefined ? {} : { status: failure.status }),
        })
      : canTryFallback(failure.unsupportedEndpoint);
    if (!fallbackAllowed) {
      return undefined;
    }
    const target = this.resolveTarget(claimed.profileRevisionId);
    if (
      target.profileRevision.invocationProtocol !==
      target.connectionRevision.protocolPreference
    ) {
      return undefined;
    }
    const now = this.options.clock.now();
    const revision: ModelProfileRevision = {
      ...target.profileRevision,
      revisionId: this.options.ids.modelProfileRevisionId(),
      invocationProtocol:
        target.profileRevision.invocationProtocol === "responses"
          ? "chat_completions"
          : "responses",
      verifiedCapabilities: [],
      state: "draft",
      createdAt: now,
    };
    return {
      revision,
      verification: {
        verificationId: this.options.ids.modelVerificationId(),
        profileRevisionId: revision.revisionId,
        expectedRevision: target.profile.recordRevision,
        capabilityBaseline: revision.capabilityBaseline,
        eventId: this.options.ids.modelRegistryEventId(),
        traceId: claimed.traceId,
        now,
      },
    };
  }

  private resolveTarget(
    profileRevisionId: ModelVerification["profileRevisionId"],
  ): VerificationTarget {
    const profile = this.options.registry
      .listProfiles()
      .find((candidate) => candidate.revisions.some(
        (revision) => revision.revisionId === profileRevisionId,
      ));
    const profileRevision = profile?.revisions.find(
      (revision) => revision.revisionId === profileRevisionId,
    );
    if (profile === undefined || profileRevision === undefined) {
      throw new Error("model_profile_revision_not_found");
    }
    const connection = this.options.registry
      .listConnections()
      .find((view) => view.revisions.some(
        (revision) => revision.revisionId === profileRevision.connectionRevisionId,
      ));
    const connectionRevision = connection?.revisions.find(
      (revision) => revision.revisionId === profileRevision.connectionRevisionId,
    );
    if (connection === undefined || connectionRevision === undefined) {
      throw new Error("provider_connection_revision_not_found");
    }
    return { profile, profileRevision, connection, connectionRevision };
  }
}

function isValidProbeCall(
  chunk: Extract<ModelChunk, { type: "tool_call" }>,
  nonce: string,
): boolean {
  if (
    chunk.name !== TOOL_PROBE_NAME ||
    !isPrintableProviderCallId(chunk.callId)
  ) return false;
  if (typeof chunk.arguments !== "object" || chunk.arguments === null || Array.isArray(chunk.arguments)) {
    return false;
  }
  const keys = Object.keys(chunk.arguments);
  return keys.length === 1 && keys[0] === "nonce" && chunk.arguments.nonce === nonce;
}

function isPrintableProviderCallId(callId: string): boolean {
  return callId.length >= 1 && callId.length <= 200 && /^[\x20-\x7E]+$/.test(callId);
}

function addUsage(
  left: ModelUsage | undefined,
  right: ModelUsage | undefined,
): ModelUsage | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}

function safeProbeFailure(error: unknown): SafeProbeFailure | undefined {
  const unsupportedEndpoint = findUnsupportedEndpointError(error);
  if (unsupportedEndpoint !== undefined) {
    return {
      code: "invocation_protocol_unsupported",
      unsupportedEndpoint: unsupportedEndpoint.evidence,
    };
  }
  const providerError = findProviderError(error);
  if (providerError !== undefined) {
    const status = safeStatus(providerError.status);
    const code = normalizedProviderCode(providerError.code);
    return {
      code: isEndpointAbsenceProtocolError(providerError.code, status)
        ? "invocation_protocol_unsupported"
        : code,
      ...(status === undefined ? {} : { status }),
    };
  }
  if (error instanceof DomainError && isProviderRuntimeErrorCode(error.code)) {
    return { code: error.code };
  }
  return undefined;
}

function findUnsupportedEndpointError(
  error: unknown,
): ValidatedUnsupportedEndpointError | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    if (current instanceof ValidatedUnsupportedEndpointError) return current;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function findProviderError(error: unknown): ModelProviderError | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    if (current instanceof ModelProviderError) return current;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function normalizedProviderCode(code: string): ProviderRuntimeErrorCode {
  return isProviderRuntimeErrorCode(code) ? code : "model_protocol_error";
}

function isProviderRuntimeErrorCode(code: string): code is ProviderRuntimeErrorCode {
  return PROVIDER_RUNTIME_ERROR_CODES.includes(code as ProviderRuntimeErrorCode);
}

function isEndpointAbsenceProtocolError(
  code: string,
  status: number | undefined,
): boolean {
  return code === "model_protocol_error" &&
    (status === 404 || status === 405 || status === 501);
}

function safeStatus(status: number | undefined): number | undefined {
  return typeof status === "number" && Number.isSafeInteger(status) &&
      status >= 400 && status <= 599
    ? status
    : undefined;
}

function assertPositiveMilliseconds(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("invalid_verification_timeout");
  }
}

function boundedAbortSignal(
  parent: AbortSignal,
  timeoutMs: number,
): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort(parent.reason);
  if (parent.aborted) {
    onParentAbort();
  } else {
    parent.addEventListener("abort", onParentAbort, { once: true });
    if (parent.aborted) {
      parent.removeEventListener("abort", onParentAbort);
      onParentAbort();
    }
  }
  const timer = setTimeout(() => {
    controller.abort(new ModelProviderError({
      code: "provider_unavailable",
      transient: true,
    }));
  }, Math.max(1, timeoutMs));
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener("abort", onParentAbort);
    },
  };
}

function linkedAbortController(parent: AbortSignal): {
  readonly controller: AbortController;
  dispose(): void;
} {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort(parent.reason);
  if (parent.aborted) {
    controller.abort(parent.reason);
  } else {
    parent.addEventListener("abort", onParentAbort, { once: true });
  }
  return {
    controller,
    dispose() {
      parent.removeEventListener("abort", onParentAbort);
    },
  };
}
