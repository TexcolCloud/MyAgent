import { DomainError } from "./errors.js";
import type {
  ModelProfileId,
  ModelProfileRevisionId,
  ProviderConnectionRevisionId,
} from "./ids.js";
import {
  MODEL_CAPABILITY_BASELINE,
  type InvocationProtocol,
  type RegistryRevisionState,
} from "./model-registry.js";
import type { PiRuntimeContract } from "./pi-runtime.js";
import type { ProviderConnectionRevision } from "./provider-connection.js";

export type ModelCapability = "streaming_text" | "single_tool_call";

export interface ModelProfileRevision {
  readonly revisionId: ModelProfileRevisionId;
  readonly profileId: ModelProfileId;
  readonly connectionRevisionId: ProviderConnectionRevisionId;
  readonly providerModelId: string;
  readonly invocationProtocol: InvocationProtocol;
  readonly piRuntime?: PiRuntimeContract;
  readonly maxInputTokens: number;
  readonly contextWindowSource: "preset" | "operator" | "assumed_32768";
  readonly capabilityBaseline: typeof MODEL_CAPABILITY_BASELINE;
  readonly verifiedCapabilities: readonly ModelCapability[];
  readonly state: RegistryRevisionState;
  readonly createdAt: Date;
}

export interface ModelProfileView {
  readonly profileId: ModelProfileId;
  readonly displayName: string;
  readonly activeRevisionId: ModelProfileRevisionId | null;
  readonly retiredAt: Date | null;
  readonly recordRevision: number;
  readonly revisions: readonly ModelProfileRevision[];
}

export function assertProfilePromotable(
  revision: ModelProfileRevision,
  connectionRevision: ProviderConnectionRevision,
): void {
  if (connectionRevision.state !== "active") {
    throw new DomainError("connection_revision_not_active");
  }
  if (revision.state === "verified" && hasBaselineCapabilities(revision)) return;
  throw new DomainError("verification_required");
}

export function assertPurgeAllowed(referenceCount: number): void {
  if (referenceCount === 0) return;
  throw new DomainError("resource_in_use");
}

export function hasBaselineCapabilities(revision: ModelProfileRevision): boolean {
  return (
    revision.verifiedCapabilities.includes("streaming_text") &&
    revision.verifiedCapabilities.includes("single_tool_call")
  );
}
