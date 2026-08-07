import type { DatabaseSync } from "node:sqlite";

import canonicalizeModule from "canonicalize";

import type { Approval } from "../../domain/approval.js";
import { ApplicationError, DomainError } from "../../domain/errors.js";
import type { ApprovalId, RunId, ToolCallId } from "../../domain/ids.js";
import type { ApprovalState } from "../../domain/states.js";
import type { ApprovalStore } from "../../ports/approval-store.js";

const canonicalizeJson = canonicalizeModule as unknown as (
  input: unknown,
) => string | undefined;

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

  decide(input: {
    approvalId: ApprovalId;
    decision: "approve" | "deny" | "expire";
    occurredAt: Date;
  }): Approval {
    const occurredAt = input.occurredAt.toISOString();
    this.inImmediateTransaction(() => {
      const approval = this.requireApproval(input.approvalId);
      const targetState = input.decision === "approve"
        ? "approved"
        : input.decision === "deny" ? "denied" : "expired";
      if (approval.state !== "pending") {
        if (approval.state === targetState) return;
        throw new ApplicationError("approval_already_resolved", 409);
      }
      const tool = this.db.prepare(
        `SELECT arguments_sha256 FROM tool_calls
         WHERE tool_call_id = ? AND run_id = ? AND state = 'waiting_approval'`,
      ).get(approval.toolCallId, approval.runId) as { arguments_sha256: string } | undefined;
      if (tool === undefined || tool.arguments_sha256 !== approval.argumentsSha256) {
        throw new DomainError("approval_tool_checkpoint_invalid");
      }
      const reason = input.decision === "approve" ? "approved" :
        input.decision === "expire" ? "approval_expired" : "approval_denied";
      const updated = this.db.prepare(
        `UPDATE approvals SET state = ?, resolved_at = ?, resolution_reason = ?
         WHERE approval_id = ? AND state = 'pending'`,
      ).run(targetState, occurredAt, reason, input.approvalId);
      if (updated.changes !== 1) throw new DomainError("approval_not_pending");
      if (input.decision === "approve") {
        this.db.prepare(
          `UPDATE tool_calls SET state = 'allowed', updated_at = ?
           WHERE tool_call_id = ? AND state = 'waiting_approval'`,
        ).run(occurredAt, approval.toolCallId);
      } else {
        this.db.prepare(
          `UPDATE tool_calls SET state = 'denied', result_json = ?, updated_at = ?
           WHERE tool_call_id = ? AND state = 'waiting_approval'`,
        ).run(canonicalize({ ok: false, code: "tool_denied", reason }), occurredAt, approval.toolCallId);
      }
      const queued = this.db.prepare(
        `UPDATE runs SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL,
         active_started_at = NULL, updated_at = ?
         WHERE run_id = ? AND state = 'waiting_approval'`,
      ).run(occurredAt, approval.runId);
      if (queued.changes !== 1) throw new DomainError("approval_run_not_waiting");
      this.appendEvent(approval.runId, "approval.resolved", canonicalize({
        approvalId: approval.approvalId, state: targetState, reason,
      }), occurredAt);
      this.appendEvent(approval.runId, "run.queued", '{"state":"queued"}', occurredAt);
    });
    return this.requireApproval(input.approvalId);
  }

  listExpired(now: Date): readonly Approval[] {
    const rows = this.db.prepare(
      `SELECT approval_id, run_id, tool_call_id, state, arguments_sha256,
              expires_at, resolved_at, resolution_reason, created_at
       FROM approvals WHERE state = 'pending' AND expires_at <= ?
       ORDER BY expires_at, approval_id`,
    ).all(now.toISOString()) as unknown as ApprovalRow[];
    return rows.map(mapApproval);
  }

  private requireApproval(approvalId: ApprovalId): Approval {
    const row = this.db.prepare(
      `SELECT approval_id, run_id, tool_call_id, state, arguments_sha256,
              expires_at, resolved_at, resolution_reason, created_at
       FROM approvals WHERE approval_id = ?`,
    ).get(approvalId) as ApprovalRow | undefined;
    if (row === undefined) throw new DomainError("approval_not_found");
    return mapApproval(row);
  }

  private appendEvent(runId: RunId, eventType: string, payloadJson: string, occurredAt: string): void {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
       FROM run_events WHERE run_id = ?`,
    ).get(runId) as { next_sequence: number };
    this.db.prepare(
      `INSERT INTO run_events (event_id, run_id, sequence, event_type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(`event:${runId}:${String(row.next_sequence)}`, runId, row.next_sequence, eventType, payloadJson, occurredAt);
  }

  private inImmediateTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function canonicalize(value: unknown): string {
  const result = canonicalizeJson(value);
  if (result === undefined) throw new DomainError("value_not_canonicalizable");
  return result;
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
