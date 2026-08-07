import type { ApprovalId } from "../domain/ids.js";
import type { Clock } from "../ports/clock.js";
import type { ApprovalStore } from "../ports/approval-store.js";

export type ApprovalDecision = "approve" | "deny";

export class DecideApprovalService {
  constructor(
    private readonly approvals: Pick<ApprovalStore, "decide">,
    private readonly clock: Pick<Clock, "now">,
  ) {}

  execute(input: { approvalId: ApprovalId; decision: ApprovalDecision }) {
    return this.approvals.decide({ ...input, occurredAt: this.clock.now() });
  }
}
