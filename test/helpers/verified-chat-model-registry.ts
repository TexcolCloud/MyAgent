import type { ProviderAuth } from "../../src/domain/provider-connection.js";
import {
  discoveryGenerationIdFromUuid,
  modelProfileRevisionIdFromUuid,
  modelRegistryEventIdFromUuid,
  modelVerificationIdFromUuid,
  parseModelProfileId,
  parseProviderConnectionId,
  providerConnectionRevisionIdFromUuid,
  type AgentId,
} from "../../src/domain/ids.js";
import type { ModelRegistryStore } from "../../src/ports/model-registry-store.js";

export function seedVerifiedChatAssignments(
  registry: Pick<
    ModelRegistryStore,
    | "createConnection"
    | "recordDiscovery"
    | "promoteConnection"
    | "createProfile"
    | "queueVerification"
    | "claimVerification"
    | "beginVerificationAttempt"
    | "completeVerification"
    | "promoteProfile"
    | "setAssignment"
  >,
  agentIds: readonly AgentId[],
  options: {
    readonly baseUrl?: string;
    readonly providerAuth?: ProviderAuth;
    readonly maxInputTokens?: number;
    readonly modelId?: string;
  } = {},
): void {
  const now = new Date("2026-08-09T00:00:00.000Z");
  const connectionId = parseProviderConnectionId("test-chat");
  const connectionRevisionId = providerConnectionRevisionIdFromUuid("test-chat");
  const profileId = parseModelProfileId("test-chat");
  const profileRevisionId = modelProfileRevisionIdFromUuid("test-chat");
  const verificationId = modelVerificationIdFromUuid("test-chat");
  registry.createConnection({
    eventId: modelRegistryEventIdFromUuid("test-chat-connection"),
    traceId: "test-chat-connection",
    now,
    connectionId,
    displayName: "Test Chat",
    providerKind: "openai_compatible",
    revision: {
      revisionId: connectionRevisionId,
      connectionId,
      state: "draft",
      baseUrl: options.baseUrl ?? "https://example.invalid/v1",
      auth: options.providerAuth ?? { type: "none" },
      allowInsecureHttp: false,
      protocolPreference: "chat_completions",
      presetVersion: "openai-chat-v1",
      createdAt: now,
    },
  });
  registry.recordDiscovery({
    eventId: modelRegistryEventIdFromUuid("test-chat-discovery"),
    traceId: "test-chat-discovery",
    now,
    connectionRevisionId,
    generationId: discoveryGenerationIdFromUuid("test-chat"),
    expectedRevision: 0,
    state: "fresh",
    models: [{ id: options.modelId ?? "test-model" }],
  });
  registry.promoteConnection({
    eventId: modelRegistryEventIdFromUuid("test-chat-promote-connection"),
    traceId: "test-chat-promote-connection",
    now,
    connectionId,
    revisionId: connectionRevisionId,
    expectedRevision: 1,
  });
  registry.createProfile({
    eventId: modelRegistryEventIdFromUuid("test-chat-profile"),
    traceId: "test-chat-profile",
    now,
    profileId,
    displayName: "Test Chat",
    revision: {
      revisionId: profileRevisionId,
      profileId,
      connectionRevisionId,
      state: "draft",
      providerModelId: options.modelId ?? "test-model",
      invocationProtocol: "chat_completions",
      maxInputTokens: options.maxInputTokens ?? 8_192,
      contextWindowSource: "operator",
      capabilityBaseline: "text_and_single_tool_call_v1",
      verifiedCapabilities: ["streaming_text", "single_tool_call"],
      createdAt: now,
    },
  });
  registry.queueVerification({
    eventId: modelRegistryEventIdFromUuid("test-chat-queue-verification"),
    traceId: "test-chat-queue-verification",
    now,
    verificationId,
    profileRevisionId,
    expectedRevision: 0,
    capabilityBaseline: "text_and_single_tool_call_v1",
  });
  const leaseOwner = "test-chat-verifier";
  registry.claimVerification({
    leaseOwner,
    now,
    leaseUntil: new Date(now.getTime() + 60_000),
  });
  registry.beginVerificationAttempt({
    verificationId,
    leaseOwner,
    now: new Date(now.getTime() + 1_000),
  });
  registry.completeVerification({
    eventId: modelRegistryEventIdFromUuid("test-chat-complete-verification"),
    traceId: "test-chat-complete-verification",
    now: new Date(now.getTime() + 2_000),
    verificationId,
    leaseOwner,
    outcome: "passed",
    capabilities: ["streaming_text", "single_tool_call"],
  });
  registry.promoteProfile({
    eventId: modelRegistryEventIdFromUuid("test-chat-promote-profile"),
    traceId: "test-chat-promote-profile",
    now: new Date(now.getTime() + 2_000),
    profileId,
    revisionId: profileRevisionId,
    expectedRevision: 1,
  });
  for (const agentId of agentIds) {
    registry.setAssignment({
      eventId: modelRegistryEventIdFromUuid(`test-chat-assignment-${agentId}`),
      traceId: `test-chat-assignment-${agentId}`,
      now,
      agentId,
      profileRevisionId,
      source: "explicit",
      expectedRevision: 0,
    });
  }
}
