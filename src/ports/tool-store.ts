import type { ApprovalId, RunId, ToolCallId } from "../domain/ids.js";
import type { JsonValue } from "../domain/json.js";
import type { PolicyEffect, PolicyFacts } from "../domain/policy.js";
import type { ToolCall } from "../domain/tool-call.js";
import type { ToolResult } from "./tool.js";

export interface ToolSkillActivation {
  skillName: string;
  skillVersion: number;
  contentSha256: string;
}

export interface RecordToolProposalInput {
  runId: RunId;
  leaseOwner: string;
  toolCallId: ToolCallId;
  providerCallId: string;
  toolName: string;
  effect: ToolCall["effect"];
  arguments: JsonValue;
  canonicalArguments: string;
  argumentsSha256: string;
  policyFacts: PolicyFacts;
  policyEffect: PolicyEffect;
  matchedRule: number | null;
  denialCode?: "invalid_tool_arguments";
  toolCallLimit: number;
  approvalId?: ApprovalId;
  approvalExpiresAt?: Date;
  occurredAt: Date;
}

export interface ToolStore {
  getLatestForRun(runId: RunId): ToolCall | null;
  listForRun(runId: RunId): readonly ToolCall[];
  recordProposal(input: RecordToolProposalInput): ToolCall;
  beginExecution(input: {
    runId: RunId;
    toolCallId: ToolCallId;
    leaseOwner: string;
    occurredAt: Date;
  }): ToolCall;
  completeExecution(input: {
    runId: RunId;
    toolCallId: ToolCallId;
    leaseOwner: string;
    result: ToolResult;
    activatedSkills: readonly ToolSkillActivation[];
    maxToolOutputBytes: number;
    maxRunToolOutputBytes: number;
    occurredAt: Date;
  }): ToolCall;
  markExecutionUnknown(input: {
    runId: RunId;
    toolCallId: ToolCallId;
    leaseOwner: string;
    occurredAt: Date;
  }): ToolCall;
  recoverExecuting(input: {
    runId: RunId;
    toolCallId: ToolCallId;
    leaseOwner: string;
    occurredAt: Date;
  }): "retry" | "reconciliation";
}

export interface ReconciliationStore {
  get(toolCallId: ToolCallId): ToolCall;
  reconcile(input: {
    toolCallId: ToolCallId;
    outcome: "succeeded" | "failed" | "retry";
    note: string;
    result?: JsonValue;
    retryToolCallId?: ToolCallId;
    approvalId?: ApprovalId;
    approvalExpiresAt?: Date;
    policyEffect?: PolicyEffect;
    matchedRule?: number | null;
    toolCallLimit?: number;
    occurredAt: Date;
  }): { toolCall: ToolCall; retryToolCallId?: ToolCallId };
}
