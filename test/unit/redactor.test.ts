import { describe, expect, it } from "vitest";

import { createStructuredLogger } from "../../src/observability/logger.js";
import { redact, secrets } from "../../src/observability/redactor.js";

describe("redact", () => {
  it("redacts by key and known Secret value without mutating input", () => {
    const input = {
      authorization: "Bearer operator-secret",
      nested: { apiKey: "provider-secret", safe: "ok" },
      message: "request failed with provider-secret",
    };

    expect(redact(input, secrets(["operator-secret", "provider-secret"]))).toEqual({
      authorization: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", safe: "ok" },
      message: "request failed with [REDACTED]",
    });
    expect(input.nested.apiKey).toBe("provider-secret");
  });

  it("redacts configured keys case-insensitively", () => {
    expect(redact({ CustomerPassword: "value", safe: true }, secrets([], {
      sensitiveKeys: ["customerPassword"],
    }))).toEqual({ CustomerPassword: "[REDACTED]", safe: true });
  });

  it("redacts known Secret values from property names", () => {
    expect(redact({ "provider-secret": "safe" }, secrets(["provider-secret"]))).toEqual({
      "[REDACTED]": "safe",
    });
  });

  it("bounds hostile depth and collection size", () => {
    const policy = secrets([], { maxDepth: 2, maxCollectionEntries: 2 });
    expect(redact(["a", "b", "c"], policy)).toEqual(["a", "b", "[TRUNCATED]"]);
    expect(redact({ a: 1, b: 2, c: 3 }, policy)).toEqual({
      a: 1,
      b: 2,
      "[TRUNCATED]": true,
    });
    expect(redact({ nested: { deeper: { value: "hidden" } } }, policy)).toEqual({
      nested: { deeper: "[TRUNCATED]" },
    });
  });

  it("replaces circular references without mutating them", () => {
    const input: { safe: string; self?: unknown } = { safe: "ok" };
    input.self = input;

    expect(redact(input, secrets([]))).toEqual({ safe: "ok", self: "[CIRCULAR]" });
    expect(input.self).toBe(input);
  });

  it("bounds circular Error metadata", () => {
    const error = new Error("safe") as Error & { code?: unknown };
    error.code = error;

    expect(redact(error, secrets([], { maxDepth: 2 }))).toEqual({
      name: "Error",
      message: "safe",
      code: "[CIRCULAR]",
    });
  });

  it("bounds Secret expansion without cutting redaction markers", () => {
    expect(redact("aaaaa", secrets(["a"], { maxStringLength: 4 }))).toBe(
      "[REDACTED][TRUNCATED]",
    );
  });
});

describe("createStructuredLogger", () => {
  it("writes redacted JSON with inherited trace and entity bindings", () => {
    const lines: string[] = [];
    const input = {
      sessionId: "session-1",
      toolCallId: "tool-1",
      providerOperationId: "provider-op-1",
      authorization: "Bearer operator-secret",
      modelOutput: "provider-secret",
      error: new Error("provider failed with provider-secret"),
    };
    const logger = createStructuredLogger({
      secretValues: ["operator-secret", "provider-secret"],
      write: (line) => { lines.push(line); },
    }).child({ traceId: "trace-1", runId: "run-1" });

    logger.error(input, "request failed with provider-secret");

    expect(lines).toHaveLength(1);
    const logged = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(logged).toMatchObject({
      level: "error",
      traceId: "trace-1",
      runId: "run-1",
      sessionId: "session-1",
      toolCallId: "tool-1",
      providerOperationId: "provider-op-1",
      authorization: "[REDACTED]",
      modelOutput: "[REDACTED]",
      message: "request failed with [REDACTED]",
      error: {
        name: "Error",
        message: "provider failed with [REDACTED]",
      },
    });
    expect(lines[0]).not.toContain("operator-secret");
    expect(lines[0]).not.toContain("provider-secret");
    expect(lines[0]).not.toContain("stack");
    expect(input.authorization).toBe("Bearer operator-secret");
  });

  it("does not throw when a hostile field getter fails", () => {
    const logger = createStructuredLogger({ write: () => {} });
    const hostile = Object.create(null, {
      value: {
        enumerable: true,
        get: () => { throw new Error("hostile getter"); },
      },
    });

    expect(() => logger.info(hostile, "safe message")).not.toThrow();
  });
});
