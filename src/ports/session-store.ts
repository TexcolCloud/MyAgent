import type { RunId, SessionId } from "../domain/ids.js";
import type { JsonValue } from "../domain/json.js";

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

export type SaveSessionSummaryInput = SessionSummary;

export interface SessionStore {
  getCurrentSummary(sessionId: SessionId): SessionSummary | null;
  listMessagesThroughRun(
    sessionId: SessionId,
    runFifoSequence: number,
  ): readonly SessionMessage[];
  saveSummary(input: SaveSessionSummaryInput): SessionSummary;
}
