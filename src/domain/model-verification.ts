import type { ModelUsage } from "../ports/model.js";
import type { VerificationResultCode } from "./errors.js";
import type { ModelProfileRevisionId, ModelVerificationId } from "./ids.js";
import {
  MODEL_CAPABILITY_BASELINE,
  type VerificationState,
} from "./model-registry.js";
import type { ModelCapability } from "./model-profile.js";

export interface ModelVerification {
  readonly verificationId: ModelVerificationId;
  readonly profileRevisionId: ModelProfileRevisionId;
  readonly capabilityBaseline: typeof MODEL_CAPABILITY_BASELINE;
  readonly state: VerificationState;
  readonly attemptCount: number;
  readonly capabilities: readonly ModelCapability[];
  readonly resultCode?: VerificationResultCode;
  readonly safeStatus?: number;
  readonly usage?: ModelUsage;
  readonly traceId: string;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly cancellationRequestedAt: Date | null;
  readonly fallbackVerificationId: ModelVerificationId | null;
  readonly recordRevision: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface VerificationProviderError {
  readonly code: VerificationResultCode;
  readonly transient: boolean;
  readonly retryAfterMs?: number;
  readonly status?: number;
}

const validatedUnsupportedEndpointBrand: unique symbol = Symbol(
  "validated_unsupported_endpoint",
);

export interface ValidatedUnsupportedEndpointEvidence {
  readonly code: "unsupported_endpoint";
  readonly [validatedUnsupportedEndpointBrand]: true;
}

export function validateUnsupportedEndpointCode(
  code: string,
): ValidatedUnsupportedEndpointEvidence | null {
  return code === "unsupported_endpoint"
    ? { code, [validatedUnsupportedEndpointBrand]: true }
    : null;
}

export type VerificationRetryDecision =
  | { shouldRetry: false }
  | { shouldRetry: true; delayMs: number };

export function classifyVerificationRetry(
  error: Pick<VerificationProviderError, "code" | "transient" | "retryAfterMs">,
  attemptNumber: number,
): VerificationRetryDecision {
  const retryableCode =
    error.code === "provider_unavailable" ||
    error.code === "provider_rate_limited";
  if (!error.transient || !retryableCode || attemptNumber >= 2) {
    return { shouldRetry: false };
  }
  return {
    shouldRetry: true,
    delayMs: Math.min(Math.max(error.retryAfterMs ?? 1_000, 1_000), 30_000),
  };
}

export function canTryFallback(
  error:
    | Pick<VerificationProviderError, "status" | "code">
    | ValidatedUnsupportedEndpointEvidence,
): boolean {
  if (error.code === "unsupported_endpoint") return true;
  return (
    error.code === "invocation_protocol_unsupported" &&
    (error.status === 404 || error.status === 405 || error.status === 501)
  );
}
