import type { AgentId, RunId, SessionId } from "./ids.js";
import type { JsonValue } from "./json.js";
import type { RunBudget } from "./limits.js";
import type { RunState } from "./states.js";

export const PUBLIC_RUN_FAILURE_CODES = Object.freeze([
  "model_protocol_error",
  "provider_unavailable",
  "run_budget_exceeded",
  "run_failed",
  "tool_not_found",
] as const);

export type PublicRunFailureCode = (typeof PUBLIC_RUN_FAILURE_CODES)[number];

export interface RunFailure {
  code: PublicRunFailureCode;
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

export function publicRunFailureCode(code: string | null): PublicRunFailureCode {
  return code !== null && (PUBLIC_RUN_FAILURE_CODES as readonly string[]).includes(code)
    ? code as PublicRunFailureCode
    : "run_failed";
}
