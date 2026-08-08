import type { ApprovalId } from "../domain/ids.js";
import type { Clock } from "../ports/clock.js";
import type { ApprovalStore } from "../ports/approval-store.js";
import { noFaults, type FaultInjector } from "../runtime/fault-injector.js";

export type ApprovalDecision = "approve" | "deny";

export class DecideApprovalService {
  constructor(
    private readonly approvals: Pick<ApprovalStore, "decide">,
    private readonly clock: Pick<Clock, "now">,
    private readonly faults: FaultInjector = noFaults,
  ) {}

  async execute(input: { approvalId: ApprovalId; decision: ApprovalDecision }) {
    await this.faults.hit("before_approval_resolution");
    const approval = this.approvals.decide({ ...input, occurredAt: this.clock.now() });
    await this.faults.hit("after_approval_resolution");
    return approval;
  }
}
