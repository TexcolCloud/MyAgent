import { describe, expect, it } from "vitest";

import { ReconcileToolCallService } from "../../src/application/reconcile-tool-call.js";
import { toolCallIdFromUuid } from "../../src/domain/ids.js";

describe("ReconcileToolCallService", () => {
  it("creates one linked retry without rewriting the unknown call", () => {
    const original = toolCallIdFromUuid("00000000-0000-7000-8000-000000000201");
    const retry = toolCallIdFromUuid("00000000-0000-7000-8000-000000000202");
    const service = new ReconcileToolCallService(new FakeReconciliationStore(retry), {
      now: () => new Date(0),
      toolCallId: () => retry,
    });

    const first = service.execute({ toolCallId: original, outcome: "retry" });
    const again = service.execute({ toolCallId: original, outcome: "retry" });

    expect(again.retryToolCallId).toBe(first.retryToolCallId);
  });
});

class FakeReconciliationStore {
  private retryToolCallId: ReturnType<typeof toolCallIdFromUuid> | undefined;

  constructor(private readonly generated: ReturnType<typeof toolCallIdFromUuid>) {}

  reconcile(input: { toolCallId: ReturnType<typeof toolCallIdFromUuid>; outcome: "retry"; retryToolCallId: ReturnType<typeof toolCallIdFromUuid>; occurredAt: Date }) {
    this.retryToolCallId ??= input.retryToolCallId;
    return { toolCall: { toolCallId: input.toolCallId, state: "unknown" }, retryToolCallId: this.retryToolCallId };
  }
}
