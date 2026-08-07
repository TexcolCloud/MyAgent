import type { AgentRevisionSnapshot } from "../domain/agent-revision.js";
import type { JsonValue } from "../domain/json.js";

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelRequest {
  purpose: "run" | "session_summary";
  model: AgentRevisionSnapshot["model"];
  messages: readonly {
    role: "system" | "user" | "assistant" | "tool";
    name: string;
    content: string;
  }[];
  tools: readonly {
    name: string;
    description: string;
    inputSchema: JsonValue;
  }[];
}

export type ModelChunk =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: { name: string; arguments: JsonValue } }
  | { type: "completed"; finishReason: string; usage: ModelUsage };

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
