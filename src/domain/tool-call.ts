import type { RunId, ToolCallId } from "./ids.js";
import type { JsonValue } from "./json.js";
import type { ToolCallState } from "./states.js";

export type ToolEffect = "read_only" | "side_effect" | "internal";

export interface ToolCall {
  toolCallId: ToolCallId;
  runId: RunId;
  state: ToolCallState;
  toolName: string;
  effect: ToolEffect;
  arguments: JsonValue;
  canonicalArguments: string;
  argumentsSha256: string;
  retryOfToolCallId: ToolCallId | null;
  result: JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
}
