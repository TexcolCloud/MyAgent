import type {
  ApprovalId,
  AttemptId,
  RunId,
  SessionId,
  ToolCallId,
} from "../../src/domain/ids.js";
import type { IdGenerator } from "../../src/ports/id-generator.js";

export interface FakeIdSeed {
  sessionIds?: readonly SessionId[];
  runIds?: readonly RunId[];
  toolCallIds?: readonly ToolCallId[];
  approvalIds?: readonly ApprovalId[];
  attemptIds?: readonly AttemptId[];
}

function take<T>(queue: T[], method: string): T {
  const value = queue.shift();
  if (value === undefined) {
    throw new Error(`FakeIds.${method} queue is empty`);
  }

  return value;
}

export class FakeIds implements IdGenerator {
  private readonly sessionIds: SessionId[];
  private readonly runIds: RunId[];
  private readonly toolCallIds: ToolCallId[];
  private readonly approvalIds: ApprovalId[];
  private readonly attemptIds: AttemptId[];

  constructor(seed: FakeIdSeed = {}) {
    this.sessionIds = [...(seed.sessionIds ?? [])];
    this.runIds = [...(seed.runIds ?? [])];
    this.toolCallIds = [...(seed.toolCallIds ?? [])];
    this.approvalIds = [...(seed.approvalIds ?? [])];
    this.attemptIds = [...(seed.attemptIds ?? [])];
  }

  sessionId(): SessionId {
    return take(this.sessionIds, "sessionId");
  }

  runId(): RunId {
    return take(this.runIds, "runId");
  }

  toolCallId(): ToolCallId {
    return take(this.toolCallIds, "toolCallId");
  }

  approvalId(): ApprovalId {
    return take(this.approvalIds, "approvalId");
  }

  attemptId(): AttemptId {
    return take(this.attemptIds, "attemptId");
  }
}
