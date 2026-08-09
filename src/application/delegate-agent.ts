import type { AgentResolverPort } from "../domain/agent-revision.js";
import { DomainError } from "../domain/errors.js";
import type { AgentId, RunId, SessionId, ToolCallId } from "../domain/ids.js";
import { parseSessionKey } from "../domain/ids.js";
import type { JsonValue } from "../domain/json.js";
import type { Clock } from "../ports/clock.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type { StartDelegationInput } from "../ports/run-store.js";

export interface DelegateAgentServiceOptions {
  agents: Pick<AgentResolverPort, "resolve">;
  runs: { getExecutionContext(runId: RunId): { run: { runId: RunId; rootRunId: RunId; delegationDepth: number }; revision: { delegates: readonly AgentId[]; limits: { childRuns: number; delegationDepth: number } } }; startDelegation(input: StartDelegationInput): { childRunId: RunId; childSessionId: SessionId } };
  clock: Pick<Clock, "now">;
  ids: Pick<IdGenerator, "sessionId" | "runId">;
}
export interface DelegateAgentCommand { parentRunId: RunId; parentToolCallId: ToolCallId; targetAgentId: AgentId; task: string; context: Record<string, JsonValue>; leaseOwner: string; }
export class DelegateAgentService {
  constructor(private readonly options: DelegateAgentServiceOptions) {}
  execute(command: DelegateAgentCommand): { childRunId: RunId; childSessionId: SessionId } {
    const parent = this.options.runs.getExecutionContext(command.parentRunId);
    if (!parent.revision.delegates.includes(command.targetAgentId)) throw new DomainError("delegate_not_allowed");
    if (parent.run.delegationDepth >= parent.revision.limits.delegationDepth) throw new DomainError("delegation_depth_exceeded");
    return this.options.runs.startDelegation({ parentRunId: command.parentRunId, parentToolCallId: command.parentToolCallId, leaseOwner: command.leaseOwner, rootRunId: parent.run.rootRunId, parentDelegationDepth: parent.run.delegationDepth, parentChildRunLimit: parent.revision.limits.childRuns, parentDelegationDepthLimit: parent.revision.limits.delegationDepth, targetAgentId: command.targetAgentId, resolveTargetRevision: () => this.options.agents.resolve(command.targetAgentId), childSessionKey: parseSessionKey(`delegate:${parent.run.rootRunId}:${command.parentToolCallId}`), allocateChildSessionId: () => this.options.ids.sessionId(), allocateChildRunId: () => this.options.ids.runId(), input: { type: "text", text: JSON.stringify({ task: command.task, context: command.context }) }, occurredAt: this.options.clock.now() });
  }
}
