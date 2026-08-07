import type { DatabaseSync } from "node:sqlite";

import { DomainError } from "../../domain/errors.js";
import type { RunId, SessionId } from "../../domain/ids.js";
import type {
  SaveLeasedSessionSummaryInput,
  SaveSessionSummaryInput,
  SessionMessage,
  SessionStore,
  SessionSummary,
} from "../../ports/session-store.js";

interface MessageRow {
  message_id: string;
  session_id: string;
  run_id: string | null;
  sequence: number;
  run_fifo_sequence: number | null;
  role: SessionMessage["role"];
  content_json: string;
  created_at: string;
}

interface SummaryRow {
  summary_id: string;
  session_id: string;
  from_message_sequence: number;
  to_message_sequence: number;
  content: string;
  model_provider: string;
  model_name: string;
  created_at: string;
}

export class SqliteSessionRepository implements SessionStore {
  constructor(private readonly db: DatabaseSync) {}

  delete(sessionId: SessionId): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const session = this.db.prepare(
        `SELECT owner_session_id FROM sessions WHERE session_id = ?`,
      ).get(sessionId) as { owner_session_id: string | null } | undefined;
      if (session === undefined) throw new DomainError("session_not_found");
      if (session.owner_session_id !== null) throw new DomainError("synthetic_session_owned");
      this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getCurrentSummary(sessionId: SessionId): SessionSummary | null {
    const row = this.db
      .prepare(
        `SELECT summary.summary_id, summary.session_id,
                summary.from_message_sequence, summary.to_message_sequence,
                summary.content, summary.model_provider, summary.model_name,
                summary.created_at
         FROM sessions
         JOIN session_summaries AS summary
           ON summary.summary_id = sessions.current_summary_id
         WHERE sessions.session_id = ?`,
      )
      .get(sessionId) as SummaryRow | undefined;
    return row === undefined ? null : mapSummary(row);
  }

  listMessagesThroughRun(
    sessionId: SessionId,
    runFifoSequence: number,
  ): readonly SessionMessage[] {
    if (!Number.isSafeInteger(runFifoSequence) || runFifoSequence < 0) {
      throw new DomainError("invalid_run_fifo_sequence");
    }
    const rows = this.db
      .prepare(
        `SELECT message_id, session_id, run_id, sequence,
                run_fifo_sequence, role, content_json, created_at
         FROM messages
         WHERE session_id = ?
           AND (run_fifo_sequence IS NULL OR run_fifo_sequence <= ?)
         ORDER BY sequence`,
      )
      .all(sessionId, runFifoSequence) as unknown as MessageRow[];
    return rows.map(mapMessage);
  }

  saveSummary(input: SaveSessionSummaryInput): SessionSummary {
    assertSummary(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.saveSummaryInTransaction(input);
      this.db.exec("COMMIT");
      return { ...input };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveSummaryWithLease(input: SaveLeasedSessionSummaryInput): SessionSummary {
    assertSummary(input.summary);
    const occurredAt = input.occurredAt.toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const lease = this.db.prepare(
        `SELECT 1 AS valid
         FROM runs
         WHERE run_id = ? AND session_id = ? AND state = 'running'
           AND lease_owner = ? AND lease_expires_at > ?`,
      ).get(
        input.runId,
        input.summary.sessionId,
        input.leaseOwner,
        occurredAt,
      ) as { valid: number } | undefined;
      if (lease === undefined) {
        throw new DomainError("run_lease_lost");
      }
      this.saveSummaryInTransaction(input.summary);
      this.db.exec("COMMIT");
      return { ...input.summary };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private saveSummaryInTransaction(input: SaveSessionSummaryInput): void {
    const inserted = this.db
      .prepare(
        `INSERT INTO session_summaries (
          summary_id, session_id, from_message_sequence,
          to_message_sequence, content, model_provider, model_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(summary_id) DO UPDATE SET
          from_message_sequence = excluded.from_message_sequence,
          to_message_sequence = excluded.to_message_sequence,
          content = excluded.content,
          model_provider = excluded.model_provider,
          model_name = excluded.model_name,
          created_at = excluded.created_at
        WHERE session_summaries.session_id = excluded.session_id`,
      )
      .run(
        input.summaryId,
        input.sessionId,
        input.sourceMessageFrom,
        input.sourceMessageTo,
        input.content,
        input.modelProvider,
        input.modelName,
        input.createdAt.toISOString(),
      );
    if (inserted.changes !== 1) {
      throw new DomainError("summary_id_collision");
    }
    const updated = this.db
      .prepare(
        `UPDATE sessions
         SET current_summary_id = ?, updated_at = ?
         WHERE session_id = ?`,
      )
      .run(input.summaryId, input.createdAt.toISOString(), input.sessionId);
    if (updated.changes !== 1) {
      throw new DomainError("session_not_found");
    }
  }
}

function mapMessage(row: MessageRow): SessionMessage {
  return {
    messageId: row.message_id,
    sessionId: row.session_id as SessionId,
    runId: row.run_id as RunId | null,
    sequence: row.sequence,
    runFifoSequence: row.run_fifo_sequence,
    role: row.role,
    content: JSON.parse(row.content_json) as SessionMessage["content"],
    createdAt: new Date(row.created_at),
  };
}

function mapSummary(row: SummaryRow): SessionSummary {
  return {
    summaryId: row.summary_id,
    sessionId: row.session_id as SessionId,
    sourceMessageFrom: row.from_message_sequence,
    sourceMessageTo: row.to_message_sequence,
    content: row.content,
    modelProvider: row.model_provider,
    modelName: row.model_name,
    createdAt: new Date(row.created_at),
  };
}

function assertSummary(input: SaveSessionSummaryInput): void {
  if (
    !Number.isSafeInteger(input.sourceMessageFrom) ||
    input.sourceMessageFrom < 0 ||
    !Number.isSafeInteger(input.sourceMessageTo) ||
    input.sourceMessageTo < input.sourceMessageFrom ||
    input.content.length === 0 ||
    !Number.isFinite(input.createdAt.getTime())
  ) {
    throw new DomainError("invalid_session_summary");
  }
}
