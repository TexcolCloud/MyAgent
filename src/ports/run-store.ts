import type { AgentRevisionSnapshot } from "../domain/agent-revision.js";
import type { RunEvent, RunEventType } from "../domain/events.js";
import type {
  AgentId,
  AttemptId,
  IdempotencyKey,
  RunId,
  SessionId,
  SessionKey,
  ToolCallId,
} from "../domain/ids.js";
import type { Run } from "../domain/run.js";
import type { JsonValue } from "../domain/json.js";
import type { ModelFinishReason, ModelUsage } from "./model.js";

export type ActiveRunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "cancelling";

export interface ActiveRun {
  readonly runId: RunId;
  readonly status: ActiveRunStatus;
}

export interface CreateStoredRunInput {
  agentId: AgentId;
  sessionKey: SessionKey;
  idempotencyKey: IdempotencyKey;
  input: { type: "text"; text: string };
  source: { kind: "http"; externalId?: string };
  resolveRevision(): AgentRevisionSnapshot;
  occurredAt: Date;
  allocateSessionId(): SessionId;
  allocateRunId(): RunId;
}

export interface CreateStoredRunResult {
  run: Run;
  created: boolean;
}

export interface RunExecutionContext {
  run: Run;
  revision: AgentRevisionSnapshot;
  input: { type: "text"; text: string };
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  activeStartedAt: Date | null;
  cancellationRequestedAt: Date | null;
}

export interface BeginModelAttemptInput {
  runId: RunId;
  leaseOwner: string;
  attemptId: AttemptId;
  purpose: "run" | "session_summary";
  consumeModelTurn: boolean;
  modelTurnLimit: number;
  occurredAt: Date;
}

export interface FailModelAttemptInput {
  runId: RunId;
  leaseOwner: string;
  attemptId: AttemptId;
  code: string;
  transient: boolean;
  occurredAt: Date;
}

export interface CompleteRunInput {
  runId: RunId;
  leaseOwner: string;
  attemptId: AttemptId;
  text: string;
  finishReason: ModelFinishReason;
  usage?: ModelUsage;
  occurredAt: Date;
}

export interface StartDelegationInput {
  parentRunId: RunId;
  parentToolCallId: ToolCallId;
  leaseOwner: string;
  rootRunId: RunId;
  parentDelegationDepth: number;
  parentChildRunLimit: number;
  parentDelegationDepthLimit: number;
  targetAgentId: AgentId;
  resolveTargetRevision(): AgentRevisionSnapshot;
  childSessionKey: SessionKey;
  allocateChildSessionId(): SessionId;
  allocateChildRunId(): RunId;
  input: { type: "text"; text: string };
  occurredAt: Date;
}

export interface RunStore {
  create(input: CreateStoredRunInput): CreateStoredRunResult;
  getRun(runId: RunId): Run;
  listActiveRuns(): readonly ActiveRun[];
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
  getExecutionContext(runId: RunId): RunExecutionContext;
  listActivatedSkillNames(runId: RunId): readonly string[];
  beginModelAttempt(input: BeginModelAttemptInput): void;
  appendModelDelta(
    runId: RunId,
    leaseOwner: string,
    attemptId: AttemptId,
    text: string,
    occurredAt: Date,
  ): void;
  failModelAttempt(input: FailModelAttemptInput): void;
  failModelAttemptAndRun(input: FailModelAttemptInput): Run;
  getUnmatchedModelAttempt(runId: RunId): AttemptId | null;
  recoverUnmatchedModelAttempt(input: {
    runId: RunId;
    leaseOwner: string;
    occurredAt: Date;
  }): AttemptId | null;
  failRun(input: { runId: RunId; leaseOwner: string; code: string; occurredAt: Date }): Run;
  completeRun(input: CompleteRunInput): Run;
  startDelegation(input: StartDelegationInput): {
    childRunId: RunId;
    childSessionId: SessionId;
  };
  cancel(input: { runId: RunId; occurredAt: Date }): Run;
  finalizeCancellation(input: {
    runId: RunId;
    leaseOwner: string;
    occurredAt: Date;
  }): Run;
}
