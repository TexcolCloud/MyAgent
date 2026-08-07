import type { Approval } from "../domain/approval.js";
import type { RunId } from "../domain/ids.js";

export interface ApprovalStore {
  getPendingForRun(runId: RunId): Approval | null;
}
