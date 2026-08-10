import type { InvocationProtocol, ProviderKind } from "../domain/model-registry.js";

export interface ProviderPreset {
  readonly version: string;
  readonly baseUrl?: string;
  readonly auth: "bearer";
  readonly protocolPreference: InvocationProtocol;
}

export const PROVIDER_PRESETS: Readonly<Record<ProviderKind, Readonly<ProviderPreset>>> =
  Object.freeze({
    openai: Object.freeze({
      version: "openai-v1",
      baseUrl: "https://api.openai.com/v1",
      auth: "bearer",
      protocolPreference: "responses",
    }),
    deepseek: Object.freeze({
      version: "deepseek-v1",
      baseUrl: "https://api.deepseek.com",
      auth: "bearer",
      protocolPreference: "responses",
    }),
    openai_compatible: Object.freeze({
      version: "custom-v1",
      auth: "bearer",
      protocolPreference: "chat_completions",
    }),
  } as const);

export function providerPreset(kind: ProviderKind): Readonly<ProviderPreset> {
  return Object.freeze({ ...PROVIDER_PRESETS[kind] });
}

const MODEL_CONTEXT_PRESETS: Readonly<Record<string, number>> = Object.freeze({
  "openai:gpt-4o": 128_000,
  "openai:gpt-4o-mini": 128_000,
  "openai:gpt-4.1": 1_047_576,
  "openai:gpt-4.1-mini": 1_047_576,
  "openai:gpt-4.1-nano": 1_047_576,
  "deepseek:deepseek-chat": 64_000,
  "deepseek:deepseek-reasoner": 64_000,
});

export function modelContextPreset(
  providerKind: ProviderKind,
  modelId: string,
): number | undefined {
  return MODEL_CONTEXT_PRESETS[`${providerKind}:${modelId}`];
}
