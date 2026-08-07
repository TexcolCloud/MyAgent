import { describe, expect, it } from "vitest";

import { ReconcileToolCallService } from "../../src/application/reconcile-tool-call.js";
import {
  runIdFromUuid,
  sessionIdFromUuid,
  toolCallIdFromUuid,
} from "../../src/domain/ids.js";

describe("ReconcileToolCallService", () => {
  it("creates one linked retry without rewriting the unknown call", () => {
    const original = toolCallIdFromUuid("00000000-0000-7000-8000-000000000201");
    const retry = toolCallIdFromUuid("00000000-0000-7000-8000-000000000202");
    const service = createService(original, retry);

    const first = service.execute({ toolCallId: original, outcome: "retry" });
    const again = service.execute({ toolCallId: original, outcome: "retry" });

    expect(again.retryToolCallId).toBe(first.retryToolCallId);
  });

  it("rejects a result for retry and canonical evidence over 64 KiB", () => {
    const original = toolCallIdFromUuid("00000000-0000-7000-8000-000000000211");
    const retry = toolCallIdFromUuid("00000000-0000-7000-8000-000000000212");
    const service = createService(original, retry);

    expect(() => service.execute({
      toolCallId: original,
      outcome: "retry",
      result: { shouldNot: "be accepted" },
    })).toThrowError(expect.objectContaining({
      code: "reconciliation_retry_result_forbidden",
      status: 422,
    }));
    expect(() => service.execute({
      toolCallId: original,
      outcome: "failed",
      note: "x".repeat(64 * 1_024),
    })).toThrowError(expect.objectContaining({
      code: "reconciliation_result_too_large",
      status: 422,
    }));
  });
});

function createService(
  original: ReturnType<typeof toolCallIdFromUuid>,
  retry: ReturnType<typeof toolCallIdFromUuid>,
): ReconcileToolCallService {
  const store = new FakeReconciliationStore(original);
  return new ReconcileToolCallService({
    tools: store,
    runs: {
      getExecutionContext: () => ({
        run: {
          runId: runIdFromUuid("00000000-0000-7000-8000-000000000211"),
          sessionId: sessionIdFromUuid("00000000-0000-7000-8000-000000000211"),
          agentId: "primary" as never,
          state: "waiting_reconciliation",
          fifoSequence: 0,
          parentRunId: null,
          rootRunId: runIdFromUuid("00000000-0000-7000-8000-000000000211"),
          delegationDepth: 0,
          budget: {
            modelTurns: 0,
            toolCalls: 1,
            childRuns: 0,
            delegationDepth: 0,
            activeExecutionSeconds: 0,
            toolOutputBytes: 0,
          },
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
        revision: {
          revisionId: "revision:test",
          agentId: "primary" as never,
          displayName: "Primary",
          prompt: "test",
          model: {
            provider: "test",
            model: "test",
            baseUrl: "http://localhost",
            apiKey: { fromEnvironment: "TEST_KEY" },
            maxInputTokens: 1_000,
          },
          workspace: ".",
          skills: [],
          policy: [{ tool: "run_command", effect: "allow" }],
          delegates: [],
          limits: {
            modelTurns: 20,
            toolCalls: 12,
            childRuns: 4,
            delegationDepth: 1,
            activeExecutionSeconds: 900,
            defaultToolTimeoutMs: 120_000,
            maxToolTimeoutMs: 600_000,
            maxToolOutputBytes: 1_048_576,
            maxRunToolOutputBytes: 8_388_608,
          },
          contentSha256: "digest",
        },
        input: { type: "text", text: "test" },
        leaseOwner: null,
        leaseExpiresAt: null,
        activeStartedAt: null,
        cancellationRequestedAt: null,
      }),
    },
    policy: { decide: () => ({ effect: "allow", matchedRule: 0 }) },
    clock: { now: () => new Date(0) },
    ids: {
      toolCallId: () => retry,
      approvalId: () => { throw new Error("not_needed"); },
    },
  });
}

class FakeReconciliationStore {
  private retryToolCallId: ReturnType<typeof toolCallIdFromUuid> | undefined;

  constructor(
    private readonly original: ReturnType<typeof toolCallIdFromUuid>,
  ) {}

  get() {
    return {
      toolCallId: this.original,
      runId: runIdFromUuid("00000000-0000-7000-8000-000000000201"),
      state: "unknown" as const,
      toolName: "run_command",
      effect: "side_effect" as const,
      arguments: {},
      canonicalArguments: "{}",
      argumentsSha256: "digest",
      policyEffect: "allow" as const,
      matchedRule: 0,
      policyFacts: {},
      retryOfToolCallId: null,
      result: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  }

  reconcile(input: {
    toolCallId: ReturnType<typeof toolCallIdFromUuid>;
    outcome: "succeeded" | "failed" | "retry";
    retryToolCallId?: ReturnType<typeof toolCallIdFromUuid>;
  }) {
    if (input.outcome !== "retry" || input.retryToolCallId === undefined) {
      throw new Error("unexpected_reconciliation");
    }
    this.retryToolCallId ??= input.retryToolCallId;
    return { toolCall: this.get(), retryToolCallId: this.retryToolCallId };
  }
}
