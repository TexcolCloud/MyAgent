import type { DatabaseSync } from "node:sqlite";

import type { Approval } from "../../domain/approval.js";
import type { ApprovalId, RunId, ToolCallId } from "../../domain/ids.js";
import type { ApprovalState } from "../../domain/states.js";
import type { ApprovalStore } from "../../ports/approval-store.js";

interface ApprovalRow {
  approval_id: string;
  run_id: string;
  tool_call_id: string;
  state: ApprovalState;
  arguments_sha256: string;
  expires_at: string;
  resolved_at: string | null;
  resolution_reason: string | null;
  created_at: string;
}

export class SqliteApprovalRepository implements ApprovalStore {
  constructor(private readonly db: DatabaseSync) {}

  getPendingForRun(runId: RunId): Approval | null {
    const row = this.db
      .prepare(
        `SELECT approval_id, run_id, tool_call_id, state, arguments_sha256,
                expires_at, resolved_at, resolution_reason, created_at
         FROM approvals
         WHERE run_id = ? AND state = 'pending'
         ORDER BY created_at, approval_id
         LIMIT 1`,
      )
      .get(runId) as ApprovalRow | undefined;
    return row === undefined ? null : mapApproval(row);
  }
}

function mapApproval(row: ApprovalRow): Approval {
  return {
    approvalId: row.approval_id as ApprovalId,
    runId: row.run_id as RunId,
    toolCallId: row.tool_call_id as ToolCallId,
    state: row.state,
    argumentsSha256: row.arguments_sha256,
    expiresAt: new Date(row.expires_at),
    resolvedAt: row.resolved_at === null ? null : new Date(row.resolved_at),
    resolutionReason: row.resolution_reason,
    createdAt: new Date(row.created_at),
  };
}
