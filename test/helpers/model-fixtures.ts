import type { EffectiveModelRuntime } from "../../src/domain/agent-revision.js";
import {
  modelProfileRevisionIdFromUuid,
  providerConnectionRevisionIdFromUuid,
} from "../../src/domain/ids.js";

export function testModelRuntime(
  overrides: Partial<EffectiveModelRuntime> = {},
): EffectiveModelRuntime {
  return {
    providerConnectionRevisionId: providerConnectionRevisionIdFromUuid("test"),
    providerKind: "openai_compatible",
    baseUrl: "https://example.invalid/v1",
    providerAuth: {
      type: "bearer",
      secret: { fromEnvironment: "TEST_API_KEY" },
    },
    modelId: "test-model",
    invocationProtocol: "chat_completions",
    maxInputTokens: 8_192,
    verifiedCapabilities: ["streaming_text", "single_tool_call"],
    compatibilityPresetVersion: "openai-chat-v1",
    ...overrides,
  };
}

export const TEST_MODEL_PROFILE_REVISION_ID = modelProfileRevisionIdFromUuid("test");
