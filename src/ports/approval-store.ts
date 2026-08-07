import type { Approval } from "../domain/approval.js";
import type { ApprovalId, RunId } from "../domain/ids.js";

export interface ApprovalStore {
  getPendingForRun(runId: RunId): Approval | null;
  decide(input: {
    approvalId: ApprovalId;
    decision: "approve" | "deny" | "expire";
    occurredAt: Date;
  }): Approval;
  listExpired(now: Date): readonly Approval[];
}
