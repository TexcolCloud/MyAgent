import { describe, expect, it } from "vitest";

import {
  canTryFallback,
  classifyVerificationRetry,
} from "../../src/domain/model-verification.js";

describe("Model verification error policy", () => {
  it("allows fallback only for endpoint absence", () => {
    expect(canTryFallback({ status: 404, code: "invocation_protocol_unsupported" })).toBe(true);
    expect(canTryFallback({ status: 401, code: "provider_auth_failed" })).toBe(false);
    expect(canTryFallback({ status: 429, code: "provider_rate_limited" })).toBe(false);
    expect(canTryFallback({ status: 404, code: "provider_auth_failed" })).toBe(false);
    expect(canTryFallback({ status: 405, code: "provider_rate_limited" })).toBe(false);
    expect(canTryFallback({ status: 501, code: "provider_unavailable" })).toBe(false);
    expect(canTryFallback({ code: "unsupported_endpoint" })).toBe(true);
  });

  it("accepts only normalized provider/runtime error codes", () => {
    // @ts-expect-error Arbitrary provider codes cannot be used as fallback evidence.
    expect(canTryFallback({ status: 404, code: "provider_made_up" })).toBe(false);
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
