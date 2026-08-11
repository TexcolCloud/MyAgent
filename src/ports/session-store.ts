import type { AttemptId, RunId, SessionId } from "../domain/ids.js";
import type { JsonValue } from "../domain/json.js";
import type { ModelFinishReason, ModelUsage } from "./model.js";

export interface SessionMessage {
  messageId: string;
  sessionId: SessionId;
  runId: RunId | null;
  sequence: number;
  runFifoSequence: number | null;
  role: "system" | "user" | "assistant" | "tool";
  content: JsonValue;
  createdAt: Date;
}

export interface SessionSummary {
  summaryId: string;
  sessionId: SessionId;
  sourceMessageFrom: number;
  sourceMessageTo: number;
  content: string;
  modelProvider: string;
  modelName: string;
  createdAt: Date;
}

export interface SessionMetadata {
  sessionId: SessionId;
  agentId: string;
  sessionKey: string;
  createdAt: Date;
  updatedAt: Date;
}

export type SaveSessionSummaryInput = SessionSummary;

export interface SaveLeasedSessionSummaryInput {
  runId: RunId;
  leaseOwner: string;
  attemptId: AttemptId;
  finishReason: ModelFinishReason;
  usage?: ModelUsage;
  occurredAt: Date;
  summary: SaveSessionSummaryInput;
}

export interface SessionStore {
  delete(sessionId: SessionId): void;
  getCurrentSummary(sessionId: SessionId): SessionSummary | null;
  listMessagesThroughRun(
    sessionId: SessionId,
    runFifoSequence: number,
  ): readonly SessionMessage[];
  saveSummary(input: SaveSessionSummaryInput): SessionSummary;
  saveSummaryWithLease(input: SaveLeasedSessionSummaryInput): SessionSummary;
}

export interface SessionLookupStore {
  findByIdentity(agentId: string, sessionKey: string): SessionMetadata | null;
}
