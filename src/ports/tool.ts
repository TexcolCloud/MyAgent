import type { AgentRevisionSnapshot } from "../domain/agent-revision.js";
import type { AgentId, RunId, ToolCallId } from "../domain/ids.js";
import type { JsonValue } from "../domain/json.js";
import type { PolicyFacts } from "../domain/policy.js";

export interface ToolNormalizeContext {
  agentId: AgentId;
  revision: AgentRevisionSnapshot;
}

export interface ToolExecutionContext extends ToolNormalizeContext {
  runId: RunId;
  toolCallId: ToolCallId;
  signal: AbortSignal;
  leaseOwner: string;
  remainingRunOutputBytes: number;
  activateSkill(skillName: string): void;
}

export type ToolPolicyFacts = PolicyFacts;

export interface ToolResult {
  ok: boolean;
  summary: string;
  content: JsonValue;
  capturedBytes: number;
  truncated: boolean;
  deferred?: boolean;
}

export type ToolExecutionStartState = "never_started" | "possibly_started";

export class ToolExecutionError extends Error {
  readonly code = "tool_execution_infrastructure_failed";

  constructor(readonly startState: ToolExecutionStartState) {
    super("tool_execution_infrastructure_failed");
    this.name = "ToolExecutionError";
  }
}

export function isToolExecutionError(
  error: unknown,
): error is ToolExecutionError {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "tool_execution_infrastructure_failed" &&
    "startState" in error &&
    (error.startState === "never_started" ||
      error.startState === "possibly_started")
  );
}

export interface ToolDefinition<TArgs extends JsonValue = JsonValue> {
  readonly name: string;
  readonly effect: "read_only" | "side_effect" | "internal";
  parseAndNormalize(
    raw: JsonValue,
    context: ToolNormalizeContext,
  ): Promise<{
    arguments: TArgs;
    policyFacts: ToolPolicyFacts;
  }>;
  execute(args: TArgs, context: ToolExecutionContext): Promise<ToolResult>;
}
