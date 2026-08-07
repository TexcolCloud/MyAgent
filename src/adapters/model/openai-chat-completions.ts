import OpenAI from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions.js";

import type { JsonValue } from "../../domain/json.js";
import {
  ModelProviderError,
  type ModelChunk,
  type ModelPort,
  type ModelRequest,
  type ModelUsage,
} from "../../ports/model.js";
import type { SecretResolver } from "../../ports/secret-resolver.js";

export interface OpenAiChatCompletionsModelOptions {
  secretResolver: SecretResolver;
}

interface ToolCallFragments {
  index: number;
  name: string;
  arguments: string;
}

export class OpenAiChatCompletionsModel implements ModelPort {
  constructor(private readonly options: OpenAiChatCompletionsModelOptions) {}

  async *streamAttempt(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelChunk> {
    signal.throwIfAborted();
    const client = new OpenAI({
      apiKey: this.options.secretResolver.resolve(request.model.apiKey),
      baseURL: request.model.baseUrl,
      maxRetries: 0,
    });
    const tools = request.tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    })) as ChatCompletionTool[];
    let toolCall: ToolCallFragments | undefined;
    let finishReason: string | undefined;
    let usage: ModelUsage | undefined;

    try {
      const stream = await client.chat.completions.create(
        {
          model: request.model.model,
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })) as ChatCompletionMessageParam[],
          stream: true,
          stream_options: { include_usage: true },
          ...(tools.length === 0
            ? {}
            : { tools, parallel_tool_calls: false }),
        },
        { signal },
      );

      for await (const chunk of stream) {
        const extractedUsage = mapUsage(chunk);
        if (extractedUsage !== undefined) {
          usage = extractedUsage;
        }
        for (const choice of chunk.choices) {
          if (choice.delta.content !== null && choice.delta.content !== undefined) {
            yield { type: "text_delta", text: choice.delta.content };
          }
          toolCall = appendToolCall(toolCall, choice);
          if (choice.finish_reason !== null) {
            finishReason = choice.finish_reason;
          }
        }
      }
    } catch (error) {
      throw toModelProviderError(error, signal);
    }

    if (finishReason === undefined || usage === undefined) {
      throw protocolError();
    }
    if (toolCall !== undefined) {
      yield { type: "tool_call", call: parseToolCall(toolCall) };
    }
    yield { type: "completed", finishReason, usage };
  }
}

function appendToolCall(
  current: ToolCallFragments | undefined,
  choice: ChatCompletionChunk.Choice,
): ToolCallFragments | undefined {
  for (const delta of choice.delta.tool_calls ?? []) {
    if (current !== undefined && current.index !== delta.index) {
      throw protocolError();
    }
    current ??= { index: delta.index, name: "", arguments: "" };
    current.name += delta.function?.name ?? "";
    current.arguments += delta.function?.arguments ?? "";
  }
  return current;
}

function parseToolCall(call: ToolCallFragments): { name: string; arguments: JsonValue } {
  if (call.name.length === 0) {
    throw protocolError();
  }
  try {
    const argumentsValue = JSON.parse(call.arguments) as unknown;
    if (!isJsonValue(argumentsValue)) {
      throw protocolError();
    }
    return { name: call.name, arguments: argumentsValue };
  } catch (error) {
    if (error instanceof ModelProviderError) {
      throw error;
    }
    throw protocolError();
  }
}

function mapUsage(chunk: ChatCompletionChunk): ModelUsage | undefined {
  if (chunk.usage === null || chunk.usage === undefined) {
    return undefined;
  }
  return {
    inputTokens: chunk.usage.prompt_tokens,
    outputTokens: chunk.usage.completion_tokens,
  };
}

function toModelProviderError(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) {
    return signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted", "AbortError");
  }
  if (error instanceof ModelProviderError) {
    return error;
  }
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    return new ModelProviderError({
      transient: isTransientStatus(status),
      code: safeProviderCode(error.code, status),
      ...(status === undefined ? {} : { status }),
      ...retryAfter(error.headers),
    });
  }
  return new ModelProviderError({ transient: true, code: "provider_unavailable" });
}

function protocolError(): ModelProviderError {
  return new ModelProviderError({ transient: false, code: "model_protocol_error" });
}

function safeProviderCode(code: string | null | undefined, status: number | undefined): string {
  return code !== undefined && code !== null && /^[a-z0-9_]{1,64}$/i.test(code)
    ? code
    : `http_${String(status ?? "error")}`;
}

function isTransientStatus(status: number | undefined): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || (status !== undefined && status >= 500);
}

function retryAfter(headers: Headers | undefined): { retryAfterMs?: number } {
  const value = headers?.get("retry-after");
  if (value === null || value === undefined) {
    return {};
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return { retryAfterMs: Math.round(seconds * 1_000) };
  }
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt)
    ? { retryAfterMs: Math.max(0, retryAt - Date.now()) }
    : {};
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value !== "object") {
    return false;
  }
  return Object.values(value).every(isJsonValue);
}
