import { describe, expect, it } from "vitest";

import type {
  ControlPlaneProblemCode,
  DomainErrorCode,
  PublicProblemCode,
  VerificationResultCode,
} from "../../src/domain/errors.js";
import {
  modelVerificationResponseSchema,
  providerConnectionResponseSchema,
  type ModelVerificationResponse,
  type ProviderConnectionResponse,
} from "../../src/interfaces/http/model-control-schemas.js";

const controlPlaneProblemCode: ControlPlaneProblemCode = "revision_conflict";
const publicRunProblemCode: PublicProblemCode = "agent_unavailable";
const internalDomainErrorCode: DomainErrorCode = "file_changed";
const verificationResultCode: VerificationResultCode = "provider_unavailable";
// @ts-expect-error Lifecycle Problems are not Verification results.
const lifecycleResultCode: VerificationResultCode = "revision_conflict";
// @ts-expect-error Internal Domain errors are not public HTTP Problems.
const internalPublicProblemCode: PublicProblemCode = "file_changed";
void controlPlaneProblemCode;
void publicRunProblemCode;
void internalDomainErrorCode;
void verificationResultCode;
void lifecycleResultCode;
void internalPublicProblemCode;

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
  it("derives public response types from schemas without Secret-value fields", () => {
    const provider: ProviderConnectionResponse = providerConnectionResponseSchema.parse({
      connectionId: "deepseek",
      displayName: "DeepSeek",
      providerKind: "deepseek",
      activeRevisionId: "pcr_1",
      retiredAt: null,
      recordRevision: 1,
      credentialConfigured: true,
      secretVersionId: "msv_1",
      revisions: [{
        revisionId: "pcr_1",
        connectionId: "deepseek",
        state: "active",
        baseUrl: "https://api.deepseek.com/v1",
        allowInsecureHttp: false,
        protocolPreference: "responses",
        presetVersion: "2026-08-13",
        credentialConfigured: true,
        secretVersionId: "msv_1",
        createdAt: "2026-08-13T00:00:00.000Z",
      }],
    });
    const verification: ModelVerificationResponse = modelVerificationResponseSchema.parse(
      verificationResponse,
    );

    expect(provider.credentialConfigured).toBe(true);
    expect(provider.secretVersionId).toBe("msv_1");
    expect(verification.resultCode).toBe("provider_unavailable");
    // @ts-expect-error Provider responses never expose write-only API keys.
    void provider.apiKey;
    // @ts-expect-error Verification responses never expose raw provider payloads.
    void verification.providerResponse;
  });

  it.each([
    ["apiKey", "must-not-appear"],
    ["value", "must-not-appear"],
    ["fromEnvironment", "DEEPSEEK_API_KEY"],
  ])("rejects Provider response Secret-value field %s", (field, value) => {
    expect(providerConnectionResponseSchema.safeParse({
      connectionId: "deepseek",
      displayName: "DeepSeek",
      providerKind: "deepseek",
      activeRevisionId: null,
      retiredAt: null,
      recordRevision: 0,
      credentialConfigured: false,
      revisions: [],
      [field]: value,
    }).success).toBe(false);
  });

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
