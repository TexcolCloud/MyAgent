import { v7 as uuidV7 } from "uuid";

import {
  approvalIdFromUuid,
  attemptIdFromUuid,
  runIdFromUuid,
  sessionIdFromUuid,
  toolCallIdFromUuid,
  type ApprovalId,
  type AttemptId,
  type RunId,
  type SessionId,
  type ToolCallId,
} from "../domain/ids.js";
import type { IdGenerator } from "../ports/id-generator.js";

export class UuidIdGenerator implements IdGenerator {
  sessionId(): SessionId {
    return sessionIdFromUuid(uuidV7());
  }

  runId(): RunId {
    return runIdFromUuid(uuidV7());
  }

  toolCallId(): ToolCallId {
    return toolCallIdFromUuid(uuidV7());
  }

  approvalId(): ApprovalId {
    return approvalIdFromUuid(uuidV7());
  }

  attemptId(): AttemptId {
    return attemptIdFromUuid(uuidV7());
  }
}
