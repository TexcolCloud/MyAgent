import { DomainError } from "./errors.js";

export type RunState =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_reconciliation"
  | "completed"
  | "failed"
  | "cancelled";

export type ToolCallState =
  | "proposed"
  | "allowed"
  | "waiting_approval"
  | "denied"
  | "executing"
  | "succeeded"
  | "failed"
  | "unknown";

export type ApprovalState = "pending" | "approved" | "denied" | "expired";

const RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ["running", "cancelled"],
  running: [
    "queued",
    "waiting_approval",
    "waiting_reconciliation",
    "completed",
    "failed",
    "cancelled",
  ],
  waiting_approval: ["queued", "cancelled"],
  waiting_reconciliation: ["queued", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

const TOOL_TRANSITIONS: Record<ToolCallState, readonly ToolCallState[]> = {
  proposed: ["allowed", "waiting_approval", "denied"],
  allowed: ["executing"],
  waiting_approval: ["allowed", "denied"],
  denied: [],
  executing: ["succeeded", "failed", "unknown"],
  succeeded: [],
  failed: [],
  unknown: ["succeeded", "failed"],
};

const APPROVAL_TRANSITIONS: Record<ApprovalState, readonly ApprovalState[]> = {
  pending: ["approved", "denied", "expired"],
  approved: [],
  denied: [],
  expired: [],
};

export function assertRunTransition(from: RunState, to: RunState): void {
  if (!RUN_TRANSITIONS[from].includes(to)) {
    throw new DomainError(
      "invalid_run_transition",
      `invalid_run_transition: ${from} -> ${to}`,
    );
  }
}

export function assertToolCallTransition(
  from: ToolCallState,
  to: ToolCallState,
): void {
  if (!TOOL_TRANSITIONS[from].includes(to)) {
    throw new DomainError(
      "invalid_tool_call_transition",
      `invalid_tool_call_transition: ${from} -> ${to}`,
    );
  }
}

export function assertApprovalTransition(
  from: ApprovalState,
  to: ApprovalState,
): void {
  if (!APPROVAL_TRANSITIONS[from].includes(to)) {
    throw new DomainError(
      "invalid_approval_transition",
      `invalid_approval_transition: ${from} -> ${to}`,
    );
  }
}
