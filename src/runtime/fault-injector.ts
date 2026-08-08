export const FAULT_POINTS = [
  "before_run_claim",
  "after_run_claim",
  "before_model_attempt_commit",
  "after_model_attempt_commit",
  "before_tool_execution",
  "after_tool_execution",
  "before_approval_resolution",
  "after_approval_resolution",
  "before_worker_resume",
  "after_worker_resume",
  "before_sse_write",
  "after_sse_write",
] as const;

export type FaultPoint = typeof FAULT_POINTS[number];

export interface FaultInjector {
  hit(point: FaultPoint): Promise<void>;
}

export const noFaults: FaultInjector = Object.freeze({
  async hit(): Promise<void> {},
});
