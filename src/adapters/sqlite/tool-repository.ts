import type { DatabaseSync } from "node:sqlite";

import canonicalizeModule from "canonicalize";

import { ApplicationError, DomainError } from "../../domain/errors.js";
import type { ApprovalId, RunId, ToolCallId } from "../../domain/ids.js";
import type { JsonValue } from "../../domain/json.js";
import type { PolicyEffect } from "../../domain/policy.js";
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
  policy_effect: ToolCall["policyEffect"];
  matched_rule: number | null;
  policy_facts_json: string;
  retry_of_tool_call_id: string | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

export class SqliteToolRepository implements ToolStore {
  constructor(private readonly db: DatabaseSync) {}

  get(toolCallId: ToolCallId): ToolCall {
    return this.requireToolCall(toolCallId);
  }

  getLatestForRun(runId: RunId): ToolCall | null {
    const row = this.db
      .prepare(
        `SELECT tool_call_id, run_id, state, tool_name, effect,
                arguments_json, canonical_arguments, arguments_sha256,
                policy_effect, matched_rule, policy_facts_json,
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
        const activeSeconds = elapsedActiveSeconds(
          active?.active_started_at,
          input.occurredAt,
        );
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
      const budget = this.db.prepare(
        `SELECT tool_output_bytes, active_started_at FROM runs WHERE run_id = ?`,
      ).get(input.runId) as {
        tool_output_bytes: number;
        active_started_at: string | null;
      };
      if (
        input.result.capturedBytes > input.maxToolOutputBytes ||
        budget.tool_output_bytes + input.result.capturedBytes > input.maxRunToolOutputBytes
      ) {
        const failureResult = {
          ok: false,
          summary: "run_budget_exceeded",
          content: { code: "run_budget_exceeded" },
          capturedBytes: 0,
          truncated: true,
        } as const;
        const tool = this.db.prepare(
          `UPDATE tool_calls SET state = 'failed', result_json = ?, updated_at = ?
           WHERE tool_call_id = ? AND run_id = ? AND state = 'executing'`,
        ).run(
          canonicalize(failureResult),
          occurredAt,
          input.toolCallId,
          input.runId,
        );
        if (tool.changes !== 1) throw new DomainError("tool_not_executing");
        const activeSeconds = elapsedActiveSeconds(
          budget.active_started_at,
          input.occurredAt,
        );
        const run = this.db.prepare(
          `UPDATE runs SET state = 'failed', failure_code = 'run_budget_exceeded',
             active_elapsed_seconds = active_elapsed_seconds + ?, active_started_at = NULL,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE run_id = ? AND state = 'running' AND lease_owner = ?`,
        ).run(activeSeconds, occurredAt, input.runId, input.leaseOwner);
        if (run.changes !== 1) throw new DomainError("run_lease_lost");
        this.appendEvent(
          input.runId,
          "tool.failed",
          canonicalize({
            toolCallId: input.toolCallId,
            capturedBytes: input.result.capturedBytes,
          }),
          occurredAt,
        );
        this.appendEvent(
          input.runId,
          "run.failed",
          canonicalize({ code: "run_budget_exceeded" }),
          occurredAt,
        );
        return;
      }
      const run = this.db.prepare(
        `UPDATE runs SET tool_output_bytes = tool_output_bytes + ?, updated_at = ?
         WHERE run_id = ? AND tool_output_bytes + ? <= ?`,
      ).run(input.result.capturedBytes, occurredAt, input.runId, input.result.capturedBytes, input.maxRunToolOutputBytes);
      if (run.changes !== 1) throw new DomainError("run_budget_exceeded");
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
      const activeSeconds = elapsedActiveSeconds(
        active?.active_started_at,
        input.occurredAt,
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

  reconcile(input: {
    toolCallId: ToolCallId;
    outcome: "succeeded" | "failed" | "retry";
    note: string;
    result?: JsonValue;
    retryToolCallId?: ToolCallId;
    approvalId?: ApprovalId;
    approvalExpiresAt?: Date;
    policyEffect?: PolicyEffect;
    matchedRule?: number | null;
    toolCallLimit?: number;
    occurredAt: Date;
  }): { toolCall: ToolCall; retryToolCallId?: ToolCallId } {
    const occurredAt = input.occurredAt.toISOString();
    return this.inImmediateTransaction(() => {
      const existing = this.db.prepare(
        `SELECT outcome, retry_tool_call_id FROM reconciliations WHERE tool_call_id = ?`,
      ).get(input.toolCallId) as {
        outcome: "succeeded" | "failed" | "retry";
        retry_tool_call_id: string | null;
      } | undefined;
      if (existing !== undefined) {
        if (existing.outcome !== input.outcome) {
          throw new ApplicationError("tool_call_already_reconciled", 409);
        }
        const toolCall = this.requireToolCall(input.toolCallId);
        return existing.retry_tool_call_id === null
          ? { toolCall }
          : {
              toolCall,
              retryToolCallId: existing.retry_tool_call_id as ToolCallId,
            };
      }
      const call = this.requireToolCall(input.toolCallId);
      if (call.state !== "unknown") throw new DomainError("tool_call_not_unknown");
      const waiting = this.db.prepare(
        `SELECT 1 FROM runs WHERE run_id = ? AND state = 'waiting_reconciliation'`,
      ).get(call.runId) as unknown;
      if (waiting === undefined) throw new DomainError("run_not_waiting_reconciliation");
      if (input.outcome === "retry") {
        if (
          input.retryToolCallId === undefined ||
          input.policyEffect === undefined ||
          input.matchedRule === undefined ||
          input.toolCallLimit === undefined
        ) {
          throw new DomainError("reconciliation_retry_checkpoint_missing");
        }
        if (input.result !== undefined) {
          throw new DomainError("reconciliation_retry_result_forbidden");
        }
        const retryState = proposalState(input.policyEffect);
        this.db.prepare(
          `INSERT INTO tool_calls (
             tool_call_id, run_id, state, tool_name, effect, arguments_json,
             canonical_arguments, arguments_sha256, policy_effect, matched_rule,
             policy_facts_json, retry_of_tool_call_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.retryToolCallId,
          call.runId,
          retryState,
          call.toolName,
          call.effect,
          call.canonicalArguments,
          call.canonicalArguments,
          call.argumentsSha256,
          input.policyEffect,
          input.matchedRule,
          canonicalize(call.policyFacts),
          call.toolCallId,
          occurredAt,
          occurredAt,
        );
        if (input.policyEffect === "deny") {
          this.db.prepare(
            `UPDATE tool_calls SET result_json = ? WHERE tool_call_id = ?`,
          ).run(
            canonicalize({
              ok: false,
              code: "tool_denied",
              matchedRule: input.matchedRule,
            }),
            input.retryToolCallId,
          );
        }
        const nextRunState = input.policyEffect === "ask"
          ? "waiting_approval"
          : "queued";
        const run = this.db.prepare(
          `UPDATE runs SET state = ?, tool_call_count = tool_call_count + 1,
             updated_at = ?
           WHERE run_id = ? AND state = 'waiting_reconciliation'
             AND tool_call_count < ?`,
        ).run(
          nextRunState,
          occurredAt,
          call.runId,
          input.toolCallLimit,
        );
        if (run.changes !== 1) {
          throw new DomainError("run_reconciliation_or_budget_invalid");
        }
        this.db.prepare(
          `INSERT INTO reconciliations (
             reconciliation_id, tool_call_id, retry_tool_call_id, outcome,
             note, result_json, created_at
           ) VALUES (?, ?, ?, 'retry', ?, NULL, ?)`,
        ).run(
          `reconciliation:${input.toolCallId}`,
          input.toolCallId,
          input.retryToolCallId,
          input.note,
          occurredAt,
        );
        this.appendEvent(
          call.runId,
          "tool.proposed",
          canonicalize({
            toolCallId: input.retryToolCallId,
            toolName: call.toolName,
            effect: call.effect,
            argumentsSha256: call.argumentsSha256,
            retryOfToolCallId: call.toolCallId,
          }),
          occurredAt,
        );
        this.appendEvent(
          call.runId,
          "tool.policy_decided",
          canonicalize({
            toolCallId: input.retryToolCallId,
            effect: input.policyEffect,
            matchedRule: input.matchedRule,
          }),
          occurredAt,
        );
        if (input.policyEffect === "ask") {
          if (input.approvalId === undefined || input.approvalExpiresAt === undefined) {
            throw new DomainError("approval_checkpoint_missing");
          }
          this.db.prepare(
            `INSERT INTO approvals (
               approval_id, run_id, tool_call_id, state, arguments_sha256,
               expires_at, created_at
             ) VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
          ).run(
            input.approvalId,
            call.runId,
            input.retryToolCallId,
            call.argumentsSha256,
            input.approvalExpiresAt.toISOString(),
            occurredAt,
          );
          this.appendEvent(
            call.runId,
            "approval.required",
            canonicalize({
              approvalId: input.approvalId,
              toolCallId: input.retryToolCallId,
            }),
            occurredAt,
          );
          this.appendEvent(
            call.runId,
            "run.waiting",
            canonicalize({ state: "waiting_approval" }),
            occurredAt,
          );
        } else {
          this.appendEvent(
            call.runId,
            "run.queued",
            canonicalize({ state: "queued" }),
            occurredAt,
          );
        }
        return {
          toolCall: call,
          retryToolCallId: input.retryToolCallId,
        };
      }
      const content = {
        source: "operator",
        untrusted: true,
        note: input.note,
        result: input.result ?? null,
      } as const;
      const storedResult = {
        ok: input.outcome === "succeeded",
        summary: `operator_reported_${input.outcome}`,
        content,
        capturedBytes: Buffer.byteLength(canonicalize(content), "utf8"),
        truncated: false,
      };
      const updated = this.db.prepare(
        `UPDATE tool_calls SET state = ?, result_json = ?, updated_at = ?
         WHERE tool_call_id = ? AND state = 'unknown'`,
      ).run(
        input.outcome,
        canonicalize(storedResult),
        occurredAt,
        input.toolCallId,
      );
      if (updated.changes !== 1) throw new DomainError("tool_call_not_unknown");
      this.db.prepare(
        `INSERT INTO reconciliations (
           reconciliation_id, tool_call_id, outcome, note, result_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        `reconciliation:${input.toolCallId}`,
        input.toolCallId,
        input.outcome,
        input.note,
        input.result === undefined ? null : canonicalize(input.result),
        occurredAt,
      );
      const queued = this.db.prepare(
        `UPDATE runs SET state = 'queued', updated_at = ?
         WHERE run_id = ? AND state = 'waiting_reconciliation'`,
      ).run(occurredAt, call.runId);
      if (queued.changes !== 1) {
        throw new DomainError("run_not_waiting_reconciliation");
      }
      this.appendEvent(
        call.runId,
        input.outcome === "succeeded" ? "tool.completed" : "tool.failed",
        canonicalize({ toolCallId: input.toolCallId, source: "operator" }),
        occurredAt,
      );
      this.appendEvent(
        call.runId,
        "run.queued",
        canonicalize({ state: "queued" }),
        occurredAt,
      );
      return { toolCall: this.requireToolCall(input.toolCallId) };
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
              policy_effect, matched_rule, policy_facts_json,
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

function elapsedActiveSeconds(
  activeStartedAt: string | null | undefined,
  endedAt: Date,
): number {
  if (activeStartedAt === null || activeStartedAt === undefined) return 0;
  return Math.ceil(
    Math.max(0, endedAt.getTime() - new Date(activeStartedAt).getTime()) / 1_000,
  );
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
    policyEffect: row.policy_effect,
    matchedRule: row.matched_rule,
    policyFacts: JSON.parse(row.policy_facts_json) as ToolCall["policyFacts"],
    retryOfToolCallId: row.retry_of_tool_call_id as ToolCallId | null,
    result:
      row.result_json === null
        ? null
        : (JSON.parse(row.result_json) as JsonValue),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}
