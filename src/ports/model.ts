import type { EffectiveModelRuntime } from "../domain/agent-revision.js";
import type { JsonValue } from "../domain/json.js";

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export type ModelInput =
  | {
      type: "message";
      role: "system" | "user" | "assistant";
      name?: string;
      content: string;
    }
  | {
      type: "assistant_tool_call";
      callId: string;
      name: string;
      arguments: JsonValue;
    }
  | {
      type: "tool_result";
      callId: string;
      name: string;
      output: JsonValue;
    };

export type ModelFinishReason =
  | "completed"
  | "tool_call"
  | "length"
  | "content_filter"
  | "unknown";

export interface ModelRequest {
  purpose:
    | "run"
    | "session_summary"
    | "verification_text"
    | "verification_tool";
  model: EffectiveModelRuntime;
  input: readonly ModelInput[];
  tools: readonly {
    name: string;
    description: string;
    inputSchema: JsonValue;
  }[];
  toolChoice?: "required";
}

export type ModelChunk =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; callId: string; name: string; arguments: JsonValue }
  | {
      type: "completed";
      finishReason: ModelFinishReason;
      usage?: ModelUsage;
    };

export interface ModelPort {
  streamAttempt(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelChunk>;
}

export interface ModelProviderErrorOptions {
  transient: boolean;
  code: string;
  retryAfterMs?: number;
  status?: number;
}

export class ModelProviderError extends Error {
  readonly transient: boolean;
  readonly code: string;
  readonly retryAfterMs?: number;
  readonly status?: number;

  constructor(options: ModelProviderErrorOptions) {
    super(options.code);
    this.name = "ModelProviderError";
    this.transient = options.transient;
    this.code = options.code;
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
    if (options.status !== undefined) {
      this.status = options.status;
    }
  }
}
