import type { ApprovalId, RunId, ToolCallId } from "../domain/ids.js";
import type { JsonValue } from "../domain/json.js";
import type { PolicyEffect, PolicyFacts } from "../domain/policy.js";
import type { ToolCall } from "../domain/tool-call.js";
import type { ToolResult } from "./tool.js";

export interface RecordToolProposalInput {
  runId: RunId;
  leaseOwner: string;
  toolCallId: ToolCallId;
  toolName: string;
  effect: ToolCall["effect"];
  arguments: JsonValue;
  canonicalArguments: string;
  argumentsSha256: string;
  policyFacts: PolicyFacts;
  policyEffect: PolicyEffect;
  matchedRule: number | null;
  toolCallLimit: number;
  approvalId?: ApprovalId;
  approvalExpiresAt?: Date;
  occurredAt: Date;
}

export interface ToolStore {
  getLatestForRun(runId: RunId): ToolCall | null;
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
    maxToolOutputBytes: number;
    maxRunToolOutputBytes: number;
    occurredAt: Date;
  }): ToolCall;
  recoverExecuting(input: {
    runId: RunId;
    toolCallId: ToolCallId;
    leaseOwner: string;
    occurredAt: Date;
  }): "retry" | "reconciliation";
}
