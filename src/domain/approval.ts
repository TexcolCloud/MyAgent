import type { ApprovalId, RunId, ToolCallId } from "./ids.js";
import type { ApprovalState } from "./states.js";

export interface Approval {
  approvalId: ApprovalId;
  runId: RunId;
  toolCallId: ToolCallId;
  state: ApprovalState;
  argumentsSha256: string;
  expiresAt: Date;
  resolvedAt: Date | null;
  resolutionReason: string | null;
  createdAt: Date;
}
