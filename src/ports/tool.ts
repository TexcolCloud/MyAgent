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
