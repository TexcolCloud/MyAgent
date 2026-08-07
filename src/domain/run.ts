import type { AgentId, RunId, SessionId } from "./ids.js";
import type { RunBudget } from "./limits.js";
import type { RunState } from "./states.js";

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
  createdAt: Date;
  updatedAt: Date;
}
