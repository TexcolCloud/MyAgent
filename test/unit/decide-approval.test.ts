import { describe, expect, it } from "vitest";

import { ApplicationError } from "../../src/domain/errors.js";
import { approvalIdFromUuid } from "../../src/domain/ids.js";
import { DecideApprovalService } from "../../src/application/decide-approval.js";

describe("DecideApprovalService", () => {
  it("repeats the same decision but rejects the opposite decision", async () => {
    const store = new FakeApprovalDecisionStore();
    const service = new DecideApprovalService(store, { now: () => new Date(0) });
    const approvalId = approvalIdFromUuid("00000000-0000-7000-8000-000000000101");

    const first = await service.execute({ approvalId, decision: "approve" });

    await expect(service.execute({ approvalId, decision: "approve" })).resolves.toEqual(first);
    await expect(service.execute({ approvalId, decision: "deny" })).rejects.toThrowError(
      expect.objectContaining({ code: "approval_already_resolved", status: 409 }),
    );
  });
});

class FakeApprovalDecisionStore {
  private resolved: "approve" | "deny" | undefined;

  decide(input: { approvalId: ReturnType<typeof approvalIdFromUuid>; decision: "approve" | "deny" | "expire"; occurredAt: Date }) {
    if (input.decision === "expire") throw new Error("not_tested");
    if (this.resolved !== undefined && this.resolved !== input.decision) {
      throw new ApplicationError("approval_already_resolved", 409);
    }
    this.resolved = input.decision;
    return {
      approvalId: input.approvalId,
      runId: "run_test" as never,
      toolCallId: "call_test" as never,
      state: input.decision === "approve" ? "approved" as const : "denied" as const,
      argumentsSha256: "digest",
      expiresAt: input.occurredAt,
      resolvedAt: input.occurredAt,
      resolutionReason: input.decision,
      createdAt: input.occurredAt,
    };
  }
}
