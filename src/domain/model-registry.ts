import type { ProviderConnectionRevisionId } from "./ids.js";

export type ProviderKind = "openai" | "deepseek" | "openai_compatible";

export type InvocationProtocol = "chat_completions" | "responses";

export type RegistryRevisionState =
  | "draft"
  | "verifying"
  | "failed"
  | "verified"
  | "active"
  | "superseded"
  | "retired"
  | "legacy_trusted";

export type VerificationState =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "cancelled";

export type DiscoveryState =
  | "fresh"
  | "stale"
  | "empty"
  | "unsupported"
  | "failed";

export const MODEL_CAPABILITY_BASELINE = "text_and_single_tool_call_v1" as const;

export interface DiscoveryView {
  readonly connectionRevisionId: ProviderConnectionRevisionId;
  readonly state: DiscoveryState;
  readonly models: readonly { id: string; owner?: string; createdAt?: Date }[];
  readonly fetchedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly refreshError?: { code: string; status?: number; traceId: string };
}
