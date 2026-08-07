import type { DatabaseSync } from "node:sqlite";

import canonicalizeModule from "canonicalize";

import { DomainError } from "../../domain/errors.js";
import type { RunId, ToolCallId } from "../../domain/ids.js";
import type { JsonValue } from "../../domain/json.js";
import type { ToolCall } from "../../domain/tool-call.js";
import type { ToolCallState } from "../../domain/states.js";
import type {
  RecordToolProposalInput,
  ToolSkillActivation,
  ToolStore,
} from "../../ports/tool-store.js";
import type { ToolResult } from "../../ports/tool.js";

const canonicalizeJson = canonicalizeModule as unknown as (
  input: unknown,
) => string | undefined;

interface ToolCallRow {
  tool_call_id: string;
  run_id: string;
  state: ToolCallState;
  tool_name: string;
  effect: ToolCall["effect"];
  arguments_json: string;
  canonical_arguments: string;
  arguments_sha256: string;
  retry_of_tool_call_id: string | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

export class SqliteToolRepository implements ToolStore {
  constructor(private readonly db: DatabaseSync) {}

  getLatestForRun(runId: RunId): ToolCall | null {
    const row = this.db
      .prepare(
        `SELECT tool_call_id, run_id, state, tool_name, effect,
                arguments_json, canonical_arguments, arguments_sha256,
                retry_of_tool_call_id, result_json, created_at, updated_at
         FROM tool_calls
         WHERE run_id = ?
         ORDER BY created_at DESC, tool_call_id DESC
         LIMIT 1`,
      )
      .get(runId) as ToolCallRow | undefined;
    return row === undefined ? null : mapToolCall(row);
  }

  recordProposal(input: RecordToolProposalInput): ToolCall {
    const occurredAt = input.occurredAt.toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.db
        .prepare(
          `UPDATE runs
           SET tool_call_count = tool_call_count + 1, updated_at = ?
           WHERE run_id = ? AND state = 'running' AND lease_owner = ?
             AND lease_expires_at > ? AND tool_call_count < ?`,
        )
        .run(
          occurredAt,
          input.runId,
          input.leaseOwner,
          occurredAt,
          input.toolCallLimit,
        );
      if (run.changes !== 1) {
        throw new DomainError("run_lease_or_budget_invalid");
      }
      const state = proposalState(input.policyEffect);
      this.db
        .prepare(
          `INSERT INTO tool_calls (
            tool_call_id, run_id, state, tool_name, effect, arguments_json,
            canonical_arguments, arguments_sha256, policy_effect,
            matched_rule, policy_facts_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.toolCallId,
          input.runId,
          state,
          input.toolName,
          input.effect,
          input.canonicalArguments,
          input.canonicalArguments,
          input.argumentsSha256,
          input.policyEffect,
          input.matchedRule,
          canonicalize(input.policyFacts),
          occurredAt,
          occurredAt,
        );
      this.appendEvent(
        input.runId,
        "tool.proposed",
        canonicalize({
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          effect: input.effect,
          argumentsSha256: input.argumentsSha256,
        }),
        occurredAt,
      );
      this.appendEvent(
        input.runId,
        "tool.policy_decided",
        canonicalize({
          toolCallId: input.toolCallId,
          effect: input.policyEffect,
          matchedRule: input.matchedRule,
        }),
        occurredAt,
      );
      if (input.policyEffect === "deny") {
        this.db.prepare(
          `UPDATE tool_calls SET result_json = ?, updated_at = ? WHERE tool_call_id = ?`,
        ).run(
          canonicalize({ ok: false, code: "tool_denied", matchedRule: input.matchedRule }),
          occurredAt,
          input.toolCallId,
        );
      }
      if (input.policyEffect === "ask") {
        if (input.approvalId === undefined || input.approvalExpiresAt === undefined) {
          throw new DomainError("approval_checkpoint_missing");
        }
        const active = this.db.prepare(
          `SELECT active_started_at FROM runs WHERE run_id = ?`,
        ).get(input.runId) as { active_started_at: string | null } | undefined;
        const activeSeconds = active?.active_started_at === null || active === undefined
          ? 0
          : Math.ceil(Math.max(0, input.occurredAt.getTime() - new Date(active.active_started_at).getTime()) / 1_000);
        const waiting = this.db.prepare(
          `UPDATE runs SET state = 'waiting_approval', lease_owner = NULL, lease_expires_at = NULL,
             active_started_at = NULL, active_elapsed_seconds = active_elapsed_seconds + ?, updated_at = ?
           WHERE run_id = ? AND state = 'running' AND lease_owner = ?`,
        ).run(activeSeconds, occurredAt, input.runId, input.leaseOwner);
        if (waiting.changes !== 1) throw new DomainError("run_lease_lost");
        this.db.prepare(
          `INSERT INTO approvals (approval_id, run_id, tool_call_id, state, arguments_sha256, expires_at, created_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
        ).run(input.approvalId, input.runId, input.toolCallId, input.argumentsSha256, input.approvalExpiresAt.toISOString(), occurredAt);
        this.appendEvent(input.runId, "approval.required", canonicalize({ approvalId: input.approvalId, toolCallId: input.toolCallId }), occurredAt);
        this.appendEvent(input.runId, "run.waiting", canonicalize({ state: "waiting_approval" }), occurredAt);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const stored = this.getLatestForRun(input.runId);
    if (stored === null) {
      throw new Error("stored_tool_call_missing");
    }
    return stored;
  }

  beginExecution(input: {
    runId: RunId;
    toolCallId: ToolCallId;
    leaseOwner: string;
    occurredAt: Date;
  }): ToolCall {
    const occurredAt = input.occurredAt.toISOString();
    this.inImmediateTransaction(() => {
      this.assertCurrentLease(input.runId, input.leaseOwner, occurredAt);
      const updated = this.db.prepare(
        `UPDATE tool_calls SET state = 'executing', updated_at = ?
         WHERE tool_call_id = ? AND run_id = ? AND state = 'allowed'`,
      ).run(occurredAt, input.toolCallId, input.runId);
      if (updated.changes !== 1) throw new DomainError("tool_not_allowed");
      this.appendEvent(input.runId, "tool.started", canonicalize({ toolCallId: input.toolCallId }), occurredAt);
    });
    return this.requireToolCall(input.toolCallId);
  }

  completeExecution(input: {
    runId: RunId;
    toolCallId: ToolCallId;
    leaseOwner: string;
    result: ToolResult;
    activatedSkills: readonly ToolSkillActivation[];
    maxToolOutputBytes: number;
    maxRunToolOutputBytes: number;
    occurredAt: Date;
  }): ToolCall {
    const occurredAt = input.occurredAt.toISOString();
    this.inImmediateTransaction(() => {
      this.assertCurrentLease(input.runId, input.leaseOwner, occurredAt);
      if (input.result.capturedBytes > input.maxToolOutputBytes) {
        this.failRunForBudget(input.runId, input.leaseOwner, occurredAt);
        return;
      }
      const run = this.db.prepare(
        `UPDATE runs SET tool_output_bytes = tool_output_bytes + ?, updated_at = ?
         WHERE run_id = ? AND tool_output_bytes + ? <= ?`,
      ).run(input.result.capturedBytes, occurredAt, input.runId, input.result.capturedBytes, input.maxRunToolOutputBytes);
      if (run.changes !== 1) {
        this.failRunForBudget(input.runId, input.leaseOwner, occurredAt);
        return;
      }
      const state = input.result.ok ? "succeeded" : "failed";
      const updated = this.db.prepare(
        `UPDATE tool_calls SET state = ?, result_json = ?, updated_at = ?
         WHERE tool_call_id = ? AND run_id = ? AND state = 'executing'`,
      ).run(state, canonicalize(input.result), occurredAt, input.toolCallId, input.runId);
      if (updated.changes !== 1) throw new DomainError("tool_not_executing");
      for (const skill of input.activatedSkills) {
        const inserted = this.db.prepare(
          `INSERT OR IGNORE INTO run_activated_skills (
             run_id, skill_name, skill_version, content_sha256, activated_at
           ) VALUES (?, ?, ?, ?, ?)`,
        ).run(
          input.runId,
          skill.skillName,
          skill.skillVersion,
          skill.contentSha256,
          occurredAt,
        );
        if (inserted.changes === 1) {
          this.appendEvent(
            input.runId,
            "skill.activated",
            canonicalize({
              skillName: skill.skillName,
              skillVersion: skill.skillVersion,
            }),
            occurredAt,
          );
        }
      }
      this.appendEvent(
        input.runId,
        input.result.ok ? "tool.completed" : "tool.failed",
        canonicalize({ toolCallId: input.toolCallId, capturedBytes: input.result.capturedBytes }),
        occurredAt,
      );
    });
    return this.requireToolCall(input.toolCallId);
  }

  recoverExecuting(input: {
    runId: RunId;
    toolCallId: ToolCallId;
    leaseOwner: string;
    occurredAt: Date;
  }): "retry" | "reconciliation" {
    const occurredAt = input.occurredAt.toISOString();
    return this.inImmediateTransaction(() => {
      this.assertCurrentLease(input.runId, input.leaseOwner, occurredAt);
      const call = this.requireToolCall(input.toolCallId);
      if (call.state !== "executing") throw new DomainError("tool_not_executing");
      if (call.effect === "read_only" || call.effect === "internal") {
        this.db.prepare(
          `UPDATE tool_calls SET state = 'allowed', updated_at = ? WHERE tool_call_id = ?`,
        ).run(occurredAt, input.toolCallId);
        return "retry";
      }
      this.db.prepare(
        `UPDATE tool_calls SET state = 'unknown', updated_at = ? WHERE tool_call_id = ?`,
      ).run(occurredAt, input.toolCallId);
      const active = this.db.prepare(
        `SELECT active_started_at FROM runs WHERE run_id = ?`,
      ).get(input.runId) as { active_started_at: string | null } | undefined;
      const activeSeconds = active?.active_started_at === null || active === undefined
        ? 0
        : Math.ceil(
            Math.max(
              0,
              input.occurredAt.getTime() -
                new Date(active.active_started_at).getTime(),
            ) / 1_000,
          );
      this.db.prepare(
        `UPDATE runs SET state = 'waiting_reconciliation', lease_owner = NULL,
           lease_expires_at = NULL, active_started_at = NULL,
           active_elapsed_seconds = active_elapsed_seconds + ?, updated_at = ?
         WHERE run_id = ? AND lease_owner = ?`,
      ).run(activeSeconds, occurredAt, input.runId, input.leaseOwner);
      this.appendEvent(input.runId, "tool.unknown", canonicalize({ toolCallId: input.toolCallId }), occurredAt);
      this.appendEvent(input.runId, "run.waiting", canonicalize({ state: "waiting_reconciliation" }), occurredAt);
      return "reconciliation";
    });
  }

  private appendEvent(
    runId: RunId,
    eventType: string,
    payloadJson: string,
    occurredAt: string,
  ): void {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
         FROM run_events WHERE run_id = ?`,
      )
      .get(runId) as unknown as { next_sequence: number };
    const sequence = row.next_sequence;
    this.db
      .prepare(
        `INSERT INTO run_events (
          event_id, run_id, sequence, event_type, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `event:${runId}:${String(sequence)}`,
        runId,
        sequence,
        eventType,
        payloadJson,
        occurredAt,
      );
  }

  private requireToolCall(toolCallId: ToolCallId): ToolCall {
    const row = this.db.prepare(
      `SELECT tool_call_id, run_id, state, tool_name, effect,
              arguments_json, canonical_arguments, arguments_sha256,
              retry_of_tool_call_id, result_json, created_at, updated_at
       FROM tool_calls WHERE tool_call_id = ?`,
    ).get(toolCallId) as ToolCallRow | undefined;
    if (row === undefined) throw new DomainError("tool_call_not_found");
    return mapToolCall(row);
  }

  private assertCurrentLease(runId: RunId, leaseOwner: string, occurredAt: string): void {
    const row = this.db.prepare(
      `SELECT 1 FROM runs WHERE run_id = ? AND state = 'running'
       AND lease_owner = ? AND lease_expires_at > ?`,
    ).get(runId, leaseOwner, occurredAt) as unknown;
    if (row === undefined) throw new DomainError("run_lease_lost");
  }

  private inImmediateTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private failRunForBudget(runId: RunId, leaseOwner: string, occurredAt: string): void {
    this.db.prepare(
      `UPDATE runs SET state = 'failed', failure_code = 'run_budget_exceeded',
       active_started_at = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE run_id = ? AND lease_owner = ?`,
    ).run(occurredAt, runId, leaseOwner);
    this.appendEvent(runId, "run.failed", canonicalize({ code: "run_budget_exceeded" }), occurredAt);
  }
}

function proposalState(effect: RecordToolProposalInput["policyEffect"]): ToolCallState {
  if (effect === "allow") {
    return "allowed";
  }
  return effect === "ask" ? "waiting_approval" : "denied";
}

function canonicalize(value: unknown): string {
  const canonical = canonicalizeJson(value);
  if (canonical === undefined) {
    throw new DomainError("value_not_canonicalizable");
  }
  return canonical;
}

function mapToolCall(row: ToolCallRow): ToolCall {
  return {
    toolCallId: row.tool_call_id as ToolCallId,
    runId: row.run_id as RunId,
    state: row.state,
    toolName: row.tool_name,
    effect: row.effect,
    arguments: JSON.parse(row.arguments_json) as JsonValue,
    canonicalArguments: row.canonical_arguments,
    argumentsSha256: row.arguments_sha256,
    retryOfToolCallId: row.retry_of_tool_call_id as ToolCallId | null,
    result:
      row.result_json === null
        ? null
        : (JSON.parse(row.result_json) as JsonValue),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}
