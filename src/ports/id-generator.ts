import type {
  ApprovalId,
  AttemptId,
  RunId,
  SessionId,
  ToolCallId,
} from "../domain/ids.js";

export interface IdGenerator {
  sessionId(): SessionId;
  runId(): RunId;
  toolCallId(): ToolCallId;
  approvalId(): ApprovalId;
  attemptId(): AttemptId;
}
