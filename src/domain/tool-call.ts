import { DomainError } from "./errors.js";
import type { RunId, ToolCallId } from "./ids.js";
import type { JsonValue } from "./json.js";
import type { PolicyEffect, PolicyFacts } from "./policy.js";
import type { ToolCallState } from "./states.js";

export type ToolEffect = "read_only" | "side_effect" | "internal";

export interface ToolCall {
  toolCallId: ToolCallId;
  runId: RunId;
  state: ToolCallState;
  toolName: string;
  providerCallId: string | null;
  effect: ToolEffect;
  arguments: JsonValue;
  canonicalArguments: string;
  argumentsSha256: string;
  policyEffect: PolicyEffect;
  matchedRule: number | null;
  policyFacts: PolicyFacts;
  retryOfToolCallId: ToolCallId | null;
  result: JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
}

export function parseProviderCallId(value: string): string {
  if (!/^[\x21-\x7E]{1,200}$/.test(value)) {
    throw new DomainError("model_protocol_error");
  }
  return value;
}
