import { createHash } from "node:crypto";

import canonicalizeModule from "canonicalize";
import type { DatabaseSync } from "node:sqlite";

import type { AgentRevisionSnapshot } from "../../domain/agent-revision.js";
import type { RunEvent, RunEventType } from "../../domain/events.js";
import type { AttemptId, RunId, SessionId } from "../../domain/ids.js";
import type { JsonValue } from "../../domain/json.js";
import { publicRunFailureCode, type Run } from "../../domain/run.js";
import type { RunState } from "../../domain/states.js";
import { ApplicationError, DomainError } from "../../domain/errors.js";
import type {
  BeginModelAttemptInput,
  CompleteRunInput,
  CreateStoredRunInput,
  CreateStoredRunResult,
  FailModelAttemptInput,
  RunExecutionContext,
  RunStore,
  StartDelegationInput,
} from "../../ports/run-store.js";
import type { SqliteCatalogRepository } from "./catalog-repository.js";

interface IdempotencyRow {
  request_digest: string;
  run_id: string;
}

interface SessionRow {
  session_id: string;
}

interface SequenceRow {
  next_sequence: number;
}

interface RunRow {
  run_id: string;
  session_id: string;
  agent_id: string;
  agent_revision_id: string;
  state: string;
  fifo_sequence: number;
  parent_run_id: string | null;
  root_run_id: string | null;
  delegation_depth: number;
  model_turn_count: number;
  tool_call_count: number;
  child_run_count: number;
  active_elapsed_seconds: number;
  tool_output_bytes: number;
  input_json: string;
  output_json: string | null;
  failure_code: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  active_started_at: string | null;
  cancellation_requested_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ExecutionRow extends RunRow {
  revision_json: string;
}

interface ClaimRow {
  run_id: string;
  state: "queued" | "running";
}

interface EventRow {
  run_id: string;
  sequence: number;
  event_type: string;
  payload_json: string;
  created_at: string;
}

const canonicalizeJson = canonicalizeModule as unknown as (
  input: unknown,
) => string | undefined;

export class SqliteRunRepository implements RunStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly catalog: SqliteCatalogRepository,
  ) {}

  create(input: CreateStoredRunInput): CreateStoredRunResult {
    return this.inImmediateTransaction(() => {
      const requestJson = canonicalize({
        agentId: input.agentId,
        sessionKey: input.sessionKey,
        input: input.input,
        source:
          input.source.externalId === undefined
            ? { kind: "http" }
            : { kind: "http", externalId: input.source.externalId },
      });
      const requestDigest = createHash("sha256").update(requestJson).digest("hex");
      const existing = this.findIdempotency(input);
      if (existing !== undefined) {
        if (existing.request_digest !== requestDigest) {
          throw new ApplicationError("idempotency_conflict", 409);
        }
        const run = this.getRun(existing.run_id as RunId);
        return { run, created: false };
      }

      const revision = input.resolveRevision();
      this.catalog.save(revision);
      const occurredAt = input.occurredAt.toISOString();
      const sessionId = this.findOrCreateSession(input, revision, occurredAt);
      const runId = input.allocateRunId();
      const fifoSequence = this.nextRunSequence(sessionId);
      const inputJson = canonicalize(input.input);
      this.insertRun({
        runId,
        sessionId,
        revisionId: revision.revisionId,
        fifoSequence,
        requestDigest,
        inputJson,
        occurredAt,
      });
      this.insertOperatorMessage({
        runId,
        sessionId,
        fifoSequence,
        contentJson: inputJson,
        occurredAt,
      });
      this.insertQueuedEvent(runId, occurredAt);
      this.db
        .prepare(
          `INSERT INTO idempotency_keys (
            agent_id, session_key, key, request_digest, run_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.agentId,
          input.sessionKey,
          input.idempotencyKey,
          requestDigest,
          runId,
          occurredAt,
        );

      const run = this.getRun(runId);
      return { run, created: true };
    });
  }

  startDelegation(input: StartDelegationInput): {
    childRunId: RunId;
    childSessionId: SessionId;
  } {
    const occurredAt = input.occurredAt.toISOString();
    return this.inImmediateTransaction(() => {
      const existing = this.db.prepare(
        `SELECT runs.run_id, runs.session_id
         FROM runs JOIN sessions ON sessions.session_id = runs.session_id
         WHERE runs.parent_run_id = ? AND sessions.session_key = ?`,
      ).get(input.parentRunId, input.childSessionKey) as
        | { run_id: string; session_id: string }
        | undefined;
      if (existing !== undefined) {
        return {
          childRunId: existing.run_id as RunId,
          childSessionId: existing.session_id as SessionId,
        };
      }
      this.assertCurrentLease(input.parentRunId, input.leaseOwner, occurredAt);
      const parent = this.getExecutionContext(input.parentRunId);
      if (parent.run.delegationDepth >= input.parentDelegationDepthLimit) {
        throw new DomainError("delegation_depth_exceeded");
      }
      const executing = this.db.prepare(
        `SELECT 1 FROM tool_calls
         WHERE tool_call_id = ? AND run_id = ? AND tool_name = 'delegate_agent'
           AND state = 'executing'`,
      ).get(input.parentToolCallId, input.parentRunId);
      if (executing === undefined) throw new DomainError("delegate_tool_not_executing");
      const childCapacity = this.db.prepare(
        `UPDATE runs SET child_run_count = child_run_count + 1, updated_at = ?
         WHERE run_id = ? AND child_run_count < ?`,
      ).run(occurredAt, input.rootRunId, input.parentChildRunLimit);
      if (childCapacity.changes !== 1) {
        throw new DomainError("delegation_count_exceeded");
      }
      const targetRevision = input.resolveTargetRevision();
      const childSessionId = input.allocateChildSessionId();
      const childRunId = input.allocateChildRunId();
      this.catalog.save(targetRevision);
      this.db.prepare(
        `INSERT INTO sessions (
          session_id, agent_id, session_key, agent_revision_id, owner_session_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        childSessionId, input.targetAgentId, input.childSessionKey,
        targetRevision.revisionId, parent.run.sessionId, occurredAt, occurredAt,
      );
      const inputJson = canonicalize(input.input);
      const requestDigest = createHash("sha256").update(canonicalize({
        parentRunId: input.parentRunId,
        parentToolCallId: input.parentToolCallId,
        targetAgentId: input.targetAgentId,
        input: input.input,
      })).digest("hex");
      this.db.prepare(
        `INSERT INTO runs (
          run_id, session_id, agent_revision_id, state, fifo_sequence,
          parent_run_id, root_run_id, delegation_depth, request_digest,
          input_json, created_at, updated_at
        ) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        childRunId, childSessionId, targetRevision.revisionId,
        input.parentRunId, input.rootRunId, input.parentDelegationDepth + 1,
        requestDigest, inputJson, occurredAt, occurredAt,
      );
      this.db.prepare(
        `INSERT INTO messages (
          message_id, session_id, run_id, sequence, run_fifo_sequence,
          role, content_json, created_at
        ) VALUES (?, ?, ?, 0, 0, 'user', ?, ?)`,
      ).run(`message:${childRunId}`, childSessionId, childRunId, inputJson, occurredAt);
      this.insertQueuedEvent(childRunId, occurredAt);
      const parentBlocked = this.db.prepare(
        `UPDATE runs
         SET blocked_by_child_run_id = ?, lease_owner = NULL, lease_expires_at = NULL,
             active_elapsed_seconds = active_elapsed_seconds + ?, active_started_at = NULL,
             updated_at = ?
         WHERE run_id = ? AND state = 'running' AND lease_owner = ?`,
      ).run(
        childRunId, elapsedActiveSeconds(parent, input.occurredAt), occurredAt,
        input.parentRunId, input.leaseOwner,
      );
      if (parentBlocked.changes !== 1) throw new DomainError("run_lease_lost");
      this.appendEventInTransaction(input.parentRunId, "delegation.started", canonicalize({
        toolCallId: input.parentToolCallId, childRunId,
        targetAgentId: input.targetAgentId,
      }), occurredAt);
      return { childRunId, childSessionId };
    });
  }

  getRun(runId: RunId): Run {
    const row = this.db
      .prepare(
        `SELECT runs.*, sessions.agent_id
         FROM runs
         JOIN sessions ON sessions.session_id = runs.session_id
         WHERE runs.run_id = ?`,
      )
      .get(runId) as RunRow | undefined;
    if (row === undefined) {
      throw new Error("run_not_found");
    }
    return mapRun(row);
  }

  listEventsAfter(runId: RunId, sequence: number): readonly RunEvent[] {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error("invalid_event_sequence");
    }
    const rows = this.db
      .prepare(
        `SELECT run_id, sequence, event_type, payload_json, created_at
         FROM run_events
         WHERE run_id = ? AND sequence > ?
         ORDER BY sequence`,
      )
      .all(runId, sequence) as unknown as EventRow[];
    return rows.map(mapEvent);
  }

  appendEvent(
    runId: RunId,
    type: RunEventType,
    payload: JsonValue,
    occurredAt: Date,
  ): RunEvent {
    const occurredAtText = occurredAt.toISOString();
    const payloadJson = canonicalize(payload);
    return this.inImmediateTransaction(() => {
      const sequence = this.appendEventInTransaction(
        runId,
        type,
        payloadJson,
        occurredAtText,
      );
      return { runId, sequence, type, occurredAt, payload };
    });
  }

  claimNextEligible(leaseOwner: string, now: Date, leaseUntil: Date): Run | null {
    assertLease(leaseOwner, now, leaseUntil);
    const nowText = now.toISOString();
    const leaseUntilText = leaseUntil.toISOString();
    return this.inImmediateTransaction(() => {
      const candidate = this.db
        .prepare(
          `SELECT candidate.run_id, candidate.state
           FROM runs AS candidate
           WHERE (
             candidate.state = 'queued'
             AND candidate.fifo_sequence = (
               SELECT MIN(queued.fifo_sequence)
               FROM runs AS queued
               WHERE queued.session_id = candidate.session_id
                 AND queued.state = 'queued'
             )
             AND NOT EXISTS (
               SELECT 1
               FROM runs AS blocking
               WHERE blocking.session_id = candidate.session_id
                 AND blocking.state IN (
                   'running', 'waiting_approval', 'waiting_reconciliation'
                 )
             )
           ) OR (
           candidate.state = 'running'
             AND candidate.blocked_by_child_run_id IS NULL
             AND (
               candidate.lease_expires_at IS NULL
               OR candidate.lease_expires_at <= ?
             )
           )
           ORDER BY candidate.created_at, candidate.run_id
           LIMIT 1`,
        )
        .get(nowText) as ClaimRow | undefined;
      if (candidate === undefined) {
        return null;
      }

      if (candidate.state === "queued") {
        this.db
          .prepare(
            `UPDATE runs
             SET state = 'running', lease_owner = ?, lease_expires_at = ?,
                 active_started_at = ?, updated_at = ?
             WHERE run_id = ?`,
          )
          .run(leaseOwner, leaseUntilText, nowText, nowText, candidate.run_id);
        this.appendEventInTransaction(
          candidate.run_id as RunId,
          "run.started",
          '{"state":"running"}',
          nowText,
        );
      } else {
        this.db
          .prepare(
            `UPDATE runs
             SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
             WHERE run_id = ?`,
          )
          .run(leaseOwner, leaseUntilText, nowText, candidate.run_id);
      }

      const run = this.getRun(candidate.run_id as RunId);
      return run;
    });
  }

  renewLease(runId: RunId, leaseOwner: string, leaseUntil: Date): boolean {
    assertLeaseOwner(leaseOwner);
    const result = this.db
      .prepare(
        `UPDATE runs
         SET lease_expires_at = ?
         WHERE run_id = ? AND state = 'running' AND lease_owner = ?`,
      )
      .run(leaseUntil.toISOString(), runId, leaseOwner);
    return result.changes === 1;
  }

  releaseLease(runId: RunId, leaseOwner: string): boolean {
    assertLeaseOwner(leaseOwner);
    const result = this.db
      .prepare(
        `UPDATE runs
         SET lease_owner = NULL, lease_expires_at = NULL
         WHERE run_id = ? AND state = 'running' AND lease_owner = ?`,
      )
      .run(runId, leaseOwner);
    return result.changes === 1;
  }

  getExecutionContext(runId: RunId): RunExecutionContext {
    const row = this.db
      .prepare(
        `SELECT runs.*, sessions.agent_id,
                agent_revisions.content_json AS revision_json
         FROM runs
         JOIN sessions ON sessions.session_id = runs.session_id
         JOIN agent_revisions
           ON agent_revisions.revision_id = runs.agent_revision_id
         WHERE runs.run_id = ?`,
      )
      .get(runId) as ExecutionRow | undefined;
    if (row === undefined) {
      throw new DomainError("run_not_found");
    }
    return {
      run: mapRun(row),
      revision: JSON.parse(row.revision_json) as RunExecutionContext["revision"],
      input: JSON.parse(row.input_json) as RunExecutionContext["input"],
      leaseOwner: row.lease_owner,
      leaseExpiresAt:
        row.lease_expires_at === null ? null : new Date(row.lease_expires_at),
      activeStartedAt:
        row.active_started_at === null ? null : new Date(row.active_started_at),
      cancellationRequestedAt:
        row.cancellation_requested_at === null
          ? null
          : new Date(row.cancellation_requested_at),
    };
  }

  listActivatedSkillNames(runId: RunId): readonly string[] {
    return (
      this.db
        .prepare(
          `SELECT skill_name
           FROM run_activated_skills
           WHERE run_id = ?
           ORDER BY activated_at, skill_name`,
        )
        .all(runId) as unknown as Array<{ skill_name: string }>
    ).map((row) => row.skill_name);
  }

  beginModelAttempt(input: BeginModelAttemptInput): void {
    assertLeaseOwner(input.leaseOwner);
    const occurredAt = input.occurredAt.toISOString();
    this.inImmediateTransaction(() => {
      const increment = input.consumeModelTurn ? 1 : 0;
      const updated = this.db
        .prepare(
          `UPDATE runs
           SET model_turn_count = model_turn_count + ?, updated_at = ?
           WHERE run_id = ? AND state = 'running' AND lease_owner = ?
             AND lease_expires_at > ?
             AND model_turn_count + ? <= ?`,
        )
        .run(
          increment,
          occurredAt,
          input.runId,
          input.leaseOwner,
          occurredAt,
          increment,
          input.modelTurnLimit,
        );
      if (updated.changes !== 1) {
        throw new DomainError("run_lease_or_budget_invalid");
      }
      this.appendEventInTransaction(
        input.runId,
        "model.attempt.started",
        canonicalize({ attemptId: input.attemptId, purpose: input.purpose }),
        occurredAt,
      );
    });
  }

  appendModelDelta(
    runId: RunId,
    leaseOwner: string,
    attemptId: AttemptId,
    text: string,
    occurredAt: Date,
  ): void {
    if (text.length === 0) {
      return;
    }
    const occurredAtText = occurredAt.toISOString();
    this.inImmediateTransaction(() => {
      this.assertCurrentLease(runId, leaseOwner, occurredAtText);
      this.appendEventInTransaction(
        runId,
        "message.delta",
        canonicalize({ attemptId, text }),
        occurredAtText,
      );
    });
  }

  failModelAttempt(input: FailModelAttemptInput): void {
    const occurredAt = input.occurredAt.toISOString();
    this.inImmediateTransaction(() => {
      this.assertCurrentLease(input.runId, input.leaseOwner, occurredAt);
      this.failModelAttemptInTransaction(input, occurredAt);
    });
  }

  failModelAttemptAndRun(input: FailModelAttemptInput): Run {
    const occurredAt = input.occurredAt.toISOString();
    return this.inImmediateTransaction(() => {
      this.assertCurrentLease(input.runId, input.leaseOwner, occurredAt);
      this.failModelAttemptInTransaction(input, occurredAt);
      return this.failRunInTransaction(input, occurredAt);
    });
  }

  getUnmatchedModelAttempt(runId: RunId): AttemptId | null {
    return this.findUnmatchedModelAttempt(runId);
  }

  recoverUnmatchedModelAttempt(input: {
    runId: RunId;
    leaseOwner: string;
    occurredAt: Date;
  }): AttemptId | null {
    const occurredAt = input.occurredAt.toISOString();
    return this.inImmediateTransaction(() => {
      this.assertCurrentLease(input.runId, input.leaseOwner, occurredAt);
      const attemptId = this.findUnmatchedModelAttempt(input.runId);
      if (attemptId === null) {
        return null;
      }
      this.appendEventInTransaction(
        input.runId,
        "model.attempt.failed",
        canonicalize({
          attemptId,
          code: "model_attempt_abandoned",
          transient: true,
        }),
        occurredAt,
      );
      return attemptId;
    });
  }

  failRun(input: { runId: RunId; leaseOwner: string; code: string; occurredAt: Date }): Run {
    const occurredAt = input.occurredAt.toISOString();
    return this.inImmediateTransaction(() => {
      this.assertCurrentLease(input.runId, input.leaseOwner, occurredAt);
      return this.failRunInTransaction(input, occurredAt);
    });
  }

  completeRun(input: CompleteRunInput): Run {
    const occurredAt = input.occurredAt.toISOString();
    return this.inImmediateTransaction(() => {
      this.assertCurrentLease(input.runId, input.leaseOwner, occurredAt);
      const context = this.getExecutionContext(input.runId);
      const messageSequence = this.nextMessageSequence(context.run.sessionId);
      this.db
        .prepare(
          `INSERT INTO messages (
            message_id, session_id, run_id, sequence, run_fifo_sequence,
            role, content_json, created_at
          ) VALUES (?, ?, ?, ?, ?, 'assistant', ?, ?)`,
        )
        .run(
          `message:${input.runId}:assistant:${String(messageSequence)}`,
          context.run.sessionId,
          input.runId,
          messageSequence,
          context.run.fifoSequence,
          canonicalize(input.text),
          occurredAt,
        );
      const activeSeconds = elapsedActiveSeconds(context, input.occurredAt);
      this.db
        .prepare(
          `UPDATE runs
           SET state = 'completed', output_json = ?,
               active_elapsed_seconds = active_elapsed_seconds + ?,
               active_started_at = NULL, lease_owner = NULL,
               lease_expires_at = NULL, updated_at = ?
           WHERE run_id = ? AND state = 'running' AND lease_owner = ?`,
        )
        .run(
          canonicalize({ type: "text", text: input.text }),
          activeSeconds,
          occurredAt,
          input.runId,
          input.leaseOwner,
        );
      this.appendEventInTransaction(
        input.runId,
        "message.completed",
        canonicalize({
          attemptId: input.attemptId,
          content: input.text,
          finishReason: input.finishReason,
          ...(input.usage === undefined ? {} : { usage: input.usage }),
        }),
        occurredAt,
      );
      this.appendEventInTransaction(
        input.runId,
        "run.completed",
        canonicalize({ result: input.text }),
        occurredAt,
      );
      this.resumeParentFromChildInTransaction(input.runId, occurredAt);
      return this.getRun(input.runId);
    });
  }

  cancel(input: { runId: RunId; occurredAt: Date }): Run {
    const occurredAt = input.occurredAt.toISOString();
    return this.inImmediateTransaction(() => {
      const run = this.getRun(input.runId);
      if (["completed", "failed", "cancelled"].includes(run.state)) return run;
      const blocked = this.db.prepare(
        `SELECT blocked_by_child_run_id FROM runs WHERE run_id = ?`,
      ).get(input.runId) as { blocked_by_child_run_id: string | null } | undefined;
      if (blocked?.blocked_by_child_run_id !== null && blocked !== undefined) {
        const childId = blocked.blocked_by_child_run_id as RunId;
        const child = this.getRun(childId);
        if (!['completed', 'failed', 'cancelled'].includes(child.state)) {
          if (child.state === 'running') {
            this.db.prepare(
              `UPDATE runs SET cancellation_requested_at = COALESCE(cancellation_requested_at, ?),
               updated_at = ? WHERE run_id = ? AND state = 'running'`,
            ).run(occurredAt, occurredAt, childId);
          } else {
            if (child.state === "waiting_approval") {
              this.denyPendingApprovalForCancellationInTransaction(childId, occurredAt);
            }
            this.db.prepare(
              `UPDATE runs SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
               active_started_at = NULL, updated_at = ? WHERE run_id = ?`,
            ).run(occurredAt, childId);
            this.appendEventInTransaction(childId, 'run.cancelled', canonicalize({ requested: false }), occurredAt);
          }
        }
        this.db.prepare(
          `UPDATE tool_calls SET state = 'failed', result_json = ?, updated_at = ?
           WHERE run_id = ? AND tool_name = 'delegate_agent' AND state = 'executing'`,
        ).run(canonicalize({ ok: false, summary: 'run_cancelled', content: { code: 'run_cancelled' }, capturedBytes: 0, truncated: false }), occurredAt, input.runId);
        this.db.prepare(
          `UPDATE runs SET state = 'cancelled', blocked_by_child_run_id = NULL,
           lease_owner = NULL, lease_expires_at = NULL, active_started_at = NULL,
           updated_at = ? WHERE run_id = ?`,
        ).run(occurredAt, input.runId);
        this.appendEventInTransaction(input.runId, 'run.cancelled', canonicalize({ requested: true }), occurredAt);
        return this.getRun(input.runId);
      }
      if (run.state === "running") {
        this.db.prepare(
          `UPDATE runs SET cancellation_requested_at = COALESCE(cancellation_requested_at, ?), updated_at = ?
           WHERE run_id = ? AND state = 'running'`,
        ).run(occurredAt, occurredAt, input.runId);
        return this.getRun(input.runId);
      }
      if (run.state === "waiting_approval") {
        this.denyPendingApprovalForCancellationInTransaction(input.runId, occurredAt);
      }
      this.db.prepare(
        `UPDATE runs SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
         active_started_at = NULL, updated_at = ?
         WHERE run_id = ? AND state IN ('queued', 'waiting_approval', 'waiting_reconciliation')`,
      ).run(occurredAt, input.runId);
      this.appendEventInTransaction(input.runId, "run.cancelled", canonicalize({ requested: false }), occurredAt);
      this.resumeParentFromChildInTransaction(input.runId, occurredAt);
      return this.getRun(input.runId);
    });
  }

  finalizeCancellation(input: {
    runId: RunId;
    leaseOwner: string;
    occurredAt: Date;
  }): Run {
    const occurredAt = input.occurredAt.toISOString();
    return this.inImmediateTransaction(() => {
      this.assertCurrentLease(input.runId, input.leaseOwner, occurredAt);
      const context = this.getExecutionContext(input.runId);
      if (context.cancellationRequestedAt === null) {
        throw new DomainError("run_cancellation_not_requested");
      }
      const executingTool = this.db.prepare(
        `SELECT tool_call_id, effect FROM tool_calls
         WHERE run_id = ? AND state = 'executing'
         ORDER BY created_at DESC, tool_call_id DESC LIMIT 1`,
      ).get(input.runId) as {
        tool_call_id: string;
        effect: "read_only" | "side_effect" | "internal";
      } | undefined;
      if (executingTool !== undefined) {
        if (executingTool.effect === "side_effect") {
          this.db.prepare(
            `UPDATE tool_calls SET state = 'unknown', updated_at = ?
             WHERE tool_call_id = ? AND state = 'executing'`,
          ).run(occurredAt, executingTool.tool_call_id);
          const waiting = this.db.prepare(
            `UPDATE runs SET state = 'waiting_reconciliation',
               active_elapsed_seconds = active_elapsed_seconds + ?,
               active_started_at = NULL, lease_owner = NULL,
               lease_expires_at = NULL, updated_at = ?
             WHERE run_id = ? AND state = 'running' AND lease_owner = ?
               AND cancellation_requested_at IS NOT NULL`,
          ).run(
            elapsedActiveSeconds(context, input.occurredAt),
            occurredAt,
            input.runId,
            input.leaseOwner,
          );
          if (waiting.changes !== 1) throw new DomainError("run_lease_lost");
          this.appendEventInTransaction(
            input.runId,
            "tool.unknown",
            canonicalize({ toolCallId: executingTool.tool_call_id }),
            occurredAt,
          );
          this.appendEventInTransaction(
            input.runId,
            "run.waiting",
            canonicalize({ state: "waiting_reconciliation" }),
            occurredAt,
          );
          return this.getRun(input.runId);
        }
        const cancelledResult = canonicalize({
          ok: false,
          summary: "run_cancelled",
          content: { code: "run_cancelled" },
          capturedBytes: 0,
          truncated: false,
        });
        const failed = this.db.prepare(
          `UPDATE tool_calls SET state = 'failed', result_json = ?, updated_at = ?
           WHERE tool_call_id = ? AND state = 'executing'`,
        ).run(cancelledResult, occurredAt, executingTool.tool_call_id);
        if (failed.changes !== 1) throw new DomainError("tool_not_executing");
        this.appendEventInTransaction(
          input.runId,
          "tool.failed",
          canonicalize({
            toolCallId: executingTool.tool_call_id,
            code: "run_cancelled",
          }),
          occurredAt,
        );
      }
      const unmatchedAttempt = this.findUnmatchedModelAttempt(input.runId);
      if (unmatchedAttempt !== null) {
        this.appendEventInTransaction(
          input.runId,
          "model.attempt.failed",
          canonicalize({
            attemptId: unmatchedAttempt,
            code: "run_cancelled",
            transient: false,
          }),
          occurredAt,
        );
      }
      const cancelled = this.db.prepare(
        `UPDATE runs SET state = 'cancelled',
           active_elapsed_seconds = active_elapsed_seconds + ?,
           active_started_at = NULL, lease_owner = NULL, lease_expires_at = NULL,
           updated_at = ?
         WHERE run_id = ? AND state = 'running' AND lease_owner = ?
           AND cancellation_requested_at IS NOT NULL`,
      ).run(
        elapsedActiveSeconds(context, input.occurredAt),
        occurredAt,
        input.runId,
        input.leaseOwner,
      );
      if (cancelled.changes !== 1) throw new DomainError("run_lease_lost");
      this.appendEventInTransaction(
        input.runId,
        "run.cancelled",
        canonicalize({ requestedAt: context.cancellationRequestedAt.toISOString() }),
        occurredAt,
      );
      this.resumeParentFromChildInTransaction(input.runId, occurredAt);
      return this.getRun(input.runId);
    });
  }

  private denyPendingApprovalForCancellationInTransaction(
    runId: RunId,
    occurredAt: string,
  ): void {
    const approval = this.db.prepare(
      `SELECT approval_id, tool_call_id FROM approvals WHERE run_id = ? AND state = 'pending'`,
    ).get(runId) as { approval_id: string; tool_call_id: string } | undefined;
    if (approval === undefined) return;
    this.db.prepare(
      `UPDATE approvals SET state = 'denied', resolved_at = ?, resolution_reason = 'run_cancelled'
       WHERE approval_id = ? AND state = 'pending'`,
    ).run(occurredAt, approval.approval_id);
    this.db.prepare(
      `UPDATE tool_calls SET state = 'denied', result_json = ?, updated_at = ?
       WHERE tool_call_id = ? AND state = 'waiting_approval'`,
    ).run(
      canonicalize({ ok: false, code: "tool_denied", reason: "run_cancelled" }),
      occurredAt,
      approval.tool_call_id,
    );
    this.appendEventInTransaction(runId, "approval.resolved", canonicalize({
      approvalId: approval.approval_id,
      state: "denied",
      reason: "run_cancelled",
    }), occurredAt);
  }

  private failModelAttemptInTransaction(
    input: FailModelAttemptInput,
    occurredAt: string,
  ): void {
    this.appendEventInTransaction(
      input.runId,
      "model.attempt.failed",
      canonicalize({
        attemptId: input.attemptId,
        code: input.code,
        transient: input.transient,
      }),
      occurredAt,
    );
  }

  private failRunInTransaction(
    input: { runId: RunId; leaseOwner: string; code: string; occurredAt: Date },
    occurredAt: string,
  ): Run {
    const context = this.getExecutionContext(input.runId);
    const failed = this.db.prepare(
      `UPDATE runs SET state = 'failed', failure_code = ?,
       active_elapsed_seconds = active_elapsed_seconds + ?,
       active_started_at = NULL, lease_owner = NULL, lease_expires_at = NULL,
       updated_at = ?
       WHERE run_id = ? AND state = 'running' AND lease_owner = ?`,
    ).run(
      input.code,
      elapsedActiveSeconds(context, input.occurredAt),
      occurredAt,
      input.runId,
      input.leaseOwner,
    );
    if (failed.changes !== 1) throw new DomainError("run_lease_lost");
    this.appendEventInTransaction(
      input.runId,
      "run.failed",
      canonicalize({ code: input.code }),
      occurredAt,
    );
    this.resumeParentFromChildInTransaction(input.runId, occurredAt);
    return this.getRun(input.runId);
  }

  private resumeParentFromChildInTransaction(childRunId: RunId, occurredAt: string): void {
    const child = this.db.prepare(
      `SELECT parent_run_id, state, output_json, failure_code FROM runs WHERE run_id = ?`,
    ).get(childRunId) as {
      parent_run_id: string | null; state: RunState; output_json: string | null; failure_code: string | null;
    } | undefined;
    if (child?.parent_run_id === null || child === undefined) return;
    if (!["completed", "failed", "cancelled"].includes(child.state)) return;
    const parent = this.db.prepare(
      `SELECT cancellation_requested_at FROM runs
       WHERE run_id = ? AND state = 'running' AND blocked_by_child_run_id = ?`,
    ).get(child.parent_run_id, childRunId) as { cancellation_requested_at: string | null } | undefined;
    if (parent === undefined) return;
    const output = child.output_json === null
      ? { code: child.failure_code ?? `child_${child.state}` }
      : JSON.parse(child.output_json) as JsonValue;
    const result = boundedDelegationResult(output);
    const toolState = child.state === "completed" ? "succeeded" : "failed";
    this.db.prepare(
      `UPDATE tool_calls SET state = ?, result_json = ?, updated_at = ?
       WHERE run_id = ? AND tool_name = 'delegate_agent' AND state = 'executing'`,
    ).run(toolState, canonicalize({
      ok: child.state === "completed", summary: "delegation_completed", content: {
        childRunId, state: child.state, result,
      }, capturedBytes: Buffer.byteLength(JSON.stringify(result), "utf8"), truncated: result.truncated,
    }), occurredAt, child.parent_run_id);
    const nextState = parent.cancellation_requested_at === null ? "queued" : "cancelled";
    this.db.prepare(
      `UPDATE runs SET state = ?, blocked_by_child_run_id = NULL,
       lease_owner = NULL, lease_expires_at = NULL, active_started_at = NULL,
       updated_at = ? WHERE run_id = ?`,
    ).run(nextState, occurredAt, child.parent_run_id);
    this.appendEventInTransaction(child.parent_run_id as RunId, "delegation.completed", canonicalize({
      childRunId, state: child.state,
    }), occurredAt);
    if (nextState === "cancelled") {
      this.appendEventInTransaction(child.parent_run_id as RunId, "run.cancelled", canonicalize({
        requestedAt: parent.cancellation_requested_at,
      }), occurredAt);
    }
  }

  private findUnmatchedModelAttempt(runId: RunId): AttemptId | null {
    const attempt = this.db.prepare(
      `SELECT json_extract(started.payload_json, '$.attemptId') AS attempt_id
       FROM run_events AS started
       WHERE started.run_id = ?
         AND started.event_type = 'model.attempt.started'
         AND NOT EXISTS (
           SELECT 1 FROM run_events AS failed
           WHERE failed.run_id = started.run_id
             AND failed.event_type = 'model.attempt.failed'
             AND json_extract(failed.payload_json, '$.attemptId') =
                 json_extract(started.payload_json, '$.attemptId')
         )
         AND NOT EXISTS (
           SELECT 1 FROM run_events AS completed
           WHERE completed.run_id = started.run_id
             AND completed.event_type = 'message.completed'
             AND json_extract(completed.payload_json, '$.attemptId') =
                 json_extract(started.payload_json, '$.attemptId')
         )
         AND NOT EXISTS (
           SELECT 1 FROM run_events AS proposed
           WHERE proposed.run_id = started.run_id
             AND proposed.event_type = 'tool.proposed'
             AND proposed.sequence > started.sequence
         )
         AND (
           json_extract(started.payload_json, '$.purpose') <> 'session_summary'
           OR NOT EXISTS (
             SELECT 1
             FROM runs AS summary_run
             JOIN session_summaries AS summary
               ON summary.session_id = summary_run.session_id
             WHERE summary_run.run_id = started.run_id
               AND summary.created_at >= started.created_at
           )
         )
       ORDER BY started.sequence DESC
       LIMIT 1`,
    ).get(runId) as { attempt_id: string } | undefined;
    return attempt === undefined ? null : attempt.attempt_id as AttemptId;
  }

  private assertCurrentLease(
    runId: RunId,
    leaseOwner: string,
    occurredAt: string,
  ): void {
    assertLeaseOwner(leaseOwner);
    const row = this.db
      .prepare(
        `SELECT 1 AS valid
         FROM runs
         WHERE run_id = ? AND state = 'running' AND lease_owner = ?
           AND lease_expires_at > ?`,
      )
      .get(runId, leaseOwner, occurredAt) as { valid: number } | undefined;
    if (row === undefined) {
      throw new DomainError("run_lease_lost");
    }
  }

  private findIdempotency(input: CreateStoredRunInput): IdempotencyRow | undefined {
    return this.db
      .prepare(
        `SELECT request_digest, run_id
         FROM idempotency_keys
         WHERE agent_id = ? AND session_key = ? AND key = ?`,
      )
      .get(input.agentId, input.sessionKey, input.idempotencyKey) as
      | IdempotencyRow
      | undefined;
  }

  private findOrCreateSession(
    input: CreateStoredRunInput,
    revision: AgentRevisionSnapshot,
    occurredAt: string,
  ): SessionId {
    const existing = this.db
      .prepare("SELECT session_id FROM sessions WHERE agent_id = ? AND session_key = ?")
      .get(input.agentId, input.sessionKey) as SessionRow | undefined;
    if (existing !== undefined) {
      return existing.session_id as SessionId;
    }

    const sessionId = input.allocateSessionId();
    this.db
      .prepare(
        `INSERT INTO sessions (
          session_id, agent_id, session_key, agent_revision_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        input.agentId,
        input.sessionKey,
        revision.revisionId,
        occurredAt,
        occurredAt,
      );
    return sessionId;
  }

  private nextRunSequence(sessionId: SessionId): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(fifo_sequence), -1) + 1 AS next_sequence
         FROM runs WHERE session_id = ?`,
      )
      .get(sessionId) as unknown as SequenceRow;
    return row.next_sequence;
  }

  private insertRun(input: {
    runId: RunId;
    sessionId: SessionId;
    revisionId: string;
    fifoSequence: number;
    requestDigest: string;
    inputJson: string;
    occurredAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO runs (
          run_id, session_id, agent_revision_id, state, fifo_sequence,
          parent_run_id, root_run_id, delegation_depth, request_digest,
          input_json, created_at, updated_at
        ) VALUES (?, ?, ?, 'queued', ?, NULL, ?, 0, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.sessionId,
        input.revisionId,
        input.fifoSequence,
        input.runId,
        input.requestDigest,
        input.inputJson,
        input.occurredAt,
        input.occurredAt,
      );
  }

  private insertOperatorMessage(input: {
    runId: RunId;
    sessionId: SessionId;
    fifoSequence: number;
    contentJson: string;
    occurredAt: string;
  }): void {
    const sequence = this.nextMessageSequence(input.sessionId);
    this.db
      .prepare(
        `INSERT INTO messages (
          message_id, session_id, run_id, sequence, run_fifo_sequence,
          role, content_json, created_at
        ) VALUES (?, ?, ?, ?, ?, 'user', ?, ?)`,
      )
      .run(
        `message:${input.runId}`,
        input.sessionId,
        input.runId,
        sequence,
        input.fifoSequence,
        input.contentJson,
        input.occurredAt,
      );
  }

  private nextMessageSequence(sessionId: SessionId): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(sequence), -1) + 1 AS next_sequence
         FROM messages WHERE session_id = ?`,
      )
      .get(sessionId) as unknown as SequenceRow;
    return row.next_sequence;
  }

  private insertQueuedEvent(runId: RunId, occurredAt: string): void {
    this.appendEventInTransaction(
      runId,
      "run.queued",
      '{"state":"queued"}',
      occurredAt,
    );
  }

  private appendEventInTransaction(
    runId: RunId,
    eventType: string,
    payloadJson: string,
    occurredAt: string,
  ): number {
    const sequenceRow = this.db
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
         FROM run_events WHERE run_id = ?`,
      )
      .get(runId) as unknown as SequenceRow;
    const sequence = sequenceRow.next_sequence;
    this.db
      .prepare(
        `INSERT INTO run_events (
          event_id, run_id, sequence, event_type, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `event:${runId}:${sequence}`,
        runId,
        sequence,
        eventType,
        payloadJson,
        occurredAt,
      );
    return sequence;
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

function assertLease(leaseOwner: string, now: Date, leaseUntil: Date): void {
  if (
    !isLeaseOwner(leaseOwner) ||
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(leaseUntil.getTime()) ||
    leaseUntil <= now
  ) {
    throw new Error("invalid_lease");
  }
}

function assertLeaseOwner(leaseOwner: string): void {
  if (!isLeaseOwner(leaseOwner)) {
    throw new Error("invalid_lease_owner");
  }
}

function isLeaseOwner(leaseOwner: string): boolean {
  return leaseOwner.length > 0;
}

function canonicalize(value: unknown): string {
  const canonical = canonicalizeJson(value);
  if (canonical === undefined) {
    throw new Error("value_not_canonicalizable");
  }
  return canonical;
}

function boundedDelegationResult(value: JsonValue): {
  result: JsonValue;
  truncated: boolean;
} {
  const maxBytes = 32_768;
  const serialized = JSON.stringify(value);
  const completeResult = { result: value, truncated: false };
  if (Buffer.byteLength(JSON.stringify(completeResult), "utf8") <= maxBytes) {
    return completeResult;
  }
  const codePoints = Array.from(serialized.slice(0, maxBytes));
  const buildResult = (length: number) => ({
    result: { truncated: true, preview: codePoints.slice(0, length).join("") },
    truncated: true,
  });
  let lower = 0;
  let upper = codePoints.length;
  while (lower < upper) {
    const candidate = Math.ceil((lower + upper) / 2);
    if (Buffer.byteLength(JSON.stringify(buildResult(candidate)), "utf8") <= maxBytes) {
      lower = candidate;
    } else {
      upper = candidate - 1;
    }
  }
  return buildResult(lower);
}

function mapRun(row: RunRow): Run {
  return {
    runId: row.run_id as RunId,
    sessionId: row.session_id as SessionId,
    agentId: row.agent_id as Run["agentId"],
    state: row.state as RunState,
    fifoSequence: row.fifo_sequence,
    parentRunId: row.parent_run_id as RunId | null,
    rootRunId: (row.root_run_id ?? row.run_id) as RunId,
    delegationDepth: row.delegation_depth,
    budget: {
      modelTurns: row.model_turn_count,
      toolCalls: row.tool_call_count,
      childRuns: row.child_run_count,
      delegationDepth: row.delegation_depth,
      activeExecutionSeconds: row.active_elapsed_seconds,
      toolOutputBytes: row.tool_output_bytes,
    },
    result: row.state === "completed" && row.output_json !== null
      ? JSON.parse(row.output_json) as JsonValue
      : null,
    failure: row.state === "failed"
      ? { code: publicRunFailureCode(row.failure_code) }
      : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function mapEvent(row: EventRow): RunEvent {
  return {
    runId: row.run_id as RunId,
    sequence: row.sequence,
    type: row.event_type as RunEventType,
    occurredAt: new Date(row.created_at),
    payload: JSON.parse(row.payload_json) as JsonValue,
  };
}

function elapsedActiveSeconds(
  context: RunExecutionContext,
  endedAt: Date,
): number {
  if (context.activeStartedAt === null) {
    return 0;
  }
  return Math.ceil(
    Math.max(0, endedAt.getTime() - context.activeStartedAt.getTime()) / 1_000,
  );
}
