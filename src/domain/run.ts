import type { AgentId, RunId, SessionId } from "./ids.js";
import type { JsonValue } from "./json.js";
import type { RunBudget } from "./limits.js";
import type { RunState } from "./states.js";

export interface RunFailure {
  code: string;
}

export interface Run {
  runId: RunId;
  sessionId: SessionId;
  agentId: AgentId;
  state: RunState;
  fifoSequence: number;
  parentRunId: RunId | null;
  rootRunId: RunId;
  delegationDepth: number;
  budget: RunBudget;
  result: JsonValue | null;
  failure: RunFailure | null;
  createdAt: Date;
  updatedAt: Date;
}
