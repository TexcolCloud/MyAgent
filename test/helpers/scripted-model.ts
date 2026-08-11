import type {
  ModelChunk,
  ModelPort,
  ModelRequest,
  ModelUsage,
} from "../../src/ports/model.js";

export interface ScriptedAttempt {
  chunks: readonly ModelChunk[];
  error?: Error;
}

export class ScriptedModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  private readonly attempts: ScriptedAttempt[] = [];

  script(...attempts: ScriptedAttempt[]): void {
    this.attempts.push(...attempts);
  }

  async *streamAttempt(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelChunk> {
    signal.throwIfAborted();
    this.requests.push(request);
    const attempt = this.attempts.shift();
    if (attempt === undefined) {
      throw new Error("scripted_model_attempt_missing");
    }
    for (const chunk of attempt.chunks) {
      signal.throwIfAborted();
      yield chunk;
    }
    if (attempt.error !== undefined) {
      throw attempt.error;
    }
  }
}

export function completedText(
  text: string,
  usage: ModelUsage = { inputTokens: 10, outputTokens: 2 },
): ScriptedAttempt {
  return {
    chunks: [
      { type: "text_delta", text },
      { type: "completed", finishReason: "completed", usage },
    ],
  };
}

export function transientFailureAfter(
  text: string,
  error: Error,
): ScriptedAttempt {
  return { chunks: [{ type: "text_delta", text }], error };
}
