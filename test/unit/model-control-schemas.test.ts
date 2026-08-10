import { describe, expect, it } from "vitest";

import type {
  ControlPlaneProblemCode,
  VerificationResultCode,
} from "../../src/domain/errors.js";
import { modelVerificationResponseSchema } from "../../src/interfaces/http/model-control-schemas.js";

const controlPlaneProblemCode: ControlPlaneProblemCode = "revision_conflict";
const verificationResultCode: VerificationResultCode = "provider_unavailable";
// @ts-expect-error Lifecycle Problems are not Verification results.
const lifecycleResultCode: VerificationResultCode = "revision_conflict";
void controlPlaneProblemCode;
void verificationResultCode;
void lifecycleResultCode;

const verificationResponse = {
  verificationId: "ver_contract",
  profileRevisionId: "mpr_contract",
  capabilityBaseline: "text_and_single_tool_call_v1",
  status: "failed",
  resultCode: "provider_unavailable",
  safeStatus: 503,
  capabilities: [],
  traceId: "trace-contract",
  recordRevision: 1,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:01.000Z",
  cancellationRequestedAt: null,
  fallbackProfileRevisionId: null,
  fallbackVerificationId: null,
} as const;

describe("Model control response schemas", () => {
  it.each([
    "verification_required",
    "model_assignment_required",
    "revision_conflict",
    "model_provider_locked",
  ])("rejects lifecycle code %s as a Verification result", (resultCode) => {
    expect(modelVerificationResponseSchema.safeParse({
      ...verificationResponse,
      resultCode,
    }).success).toBe(false);
  });

  it.each([
    "provider_auth_failed",
    "provider_unavailable",
    "provider_rate_limited",
    "model_not_found",
    "invocation_protocol_unsupported",
    "streaming_unsupported",
    "tool_call_unsupported",
    "model_protocol_error",
    "secret_locked",
  ])("accepts closed Verification result code %s", (resultCode) => {
    expect(modelVerificationResponseSchema.safeParse({
      ...verificationResponse,
      resultCode,
    }).success).toBe(true);
  });
});
