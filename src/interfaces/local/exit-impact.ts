import type { TuiClient, RunStatus } from "../tui/tui-client.js";

export interface ExitImpact {
  readonly activeRuns: readonly {
    readonly runId: string;
    readonly status: RunStatus;
  }[];
  readonly pendingApprovalCount: number;
}

export async function inspectExitImpact(
  client: Pick<TuiClient, "listActiveRuns" | "listPendingApprovals">,
): Promise<ExitImpact> {
  const [runs, approvals] = await Promise.all([
    client.listActiveRuns(),
    client.listPendingApprovals(),
  ]);
  return {
    activeRuns: runs.runs,
    pendingApprovalCount: approvals.approvals.length,
  };
}
