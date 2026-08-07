import type { AgentRevisionSnapshot } from "../domain/agent-revision.js";
import type { RunEvent, RunEventType } from "../domain/events.js";
import type {
  AgentId,
  IdempotencyKey,
  RunId,
  SessionId,
  SessionKey,
} from "../domain/ids.js";
import type { Run } from "../domain/run.js";
import type { JsonValue } from "../domain/json.js";

export interface CreateStoredRunInput {
  agentId: AgentId;
  sessionKey: SessionKey;
  idempotencyKey: IdempotencyKey;
  input: { type: "text"; text: string };
  source: { kind: "http"; externalId?: string };
  revision: AgentRevisionSnapshot;
  occurredAt: Date;
  allocateSessionId(): SessionId;
  allocateRunId(): RunId;
}

export interface CreateStoredRunResult {
  run: Run;
  created: boolean;
}

export interface RunStore {
  create(input: CreateStoredRunInput): CreateStoredRunResult;
  getRun(runId: RunId): Run;
  listEventsAfter(runId: RunId, sequence: number): readonly RunEvent[];
  appendEvent(
    runId: RunId,
    type: RunEventType,
    payload: JsonValue,
    occurredAt: Date,
  ): RunEvent;
  claimNextEligible(leaseOwner: string, now: Date, leaseUntil: Date): Run | null;
  renewLease(runId: RunId, leaseOwner: string, leaseUntil: Date): boolean;
  releaseLease(runId: RunId, leaseOwner: string): boolean;
}
