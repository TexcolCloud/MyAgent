import OpenAI from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions.js";

import type { JsonValue } from "../../domain/json.js";
import type { EffectiveModelRuntime } from "../../domain/agent-revision.js";
import {
  ModelProviderError,
  type ModelChunk,
  type ModelFinishReason,
  type ModelInput,
  type ModelPort,
  type ModelRequest,
  type ModelUsage,
} from "../../ports/model.js";
import type {
  ExactProviderConnectionRevision,
  ModelRegistryStore,
} from "../../ports/model-registry-store.js";
import type { ProviderHttpTransport } from "../../ports/provider-http-transport.js";

export interface OpenAiChatCompletionsModelOptions {
  transport: ProviderHttpTransport;
  connections: Pick<ModelRegistryStore, "getConnectionRevision">;
}

interface ToolCallFragments {
  index: number;
  callId: string;
  name: string;
  arguments: string;
}

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 16 * 1_024 * 1_024;

export class OpenAiChatCompletionsModel implements ModelPort {
  constructor(private readonly options: OpenAiChatCompletionsModelOptions) {}

  async *streamAttempt(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelChunk> {
    signal.throwIfAborted();
    if (request.model.invocationProtocol !== "chat_completions") {
      throw new ModelProviderError({
        transient: false,
        code: "invocation_protocol_unsupported",
      });
    }
    const connection = exactConnection(request.model, this.options.connections);
    const client = new OpenAI({
      apiKey: "transport-owned-authentication",
      baseURL: request.model.baseUrl,
      maxRetries: 0,
      fetch: this.options.transport.createFetch({
        connection: connection.revision,
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
      }),
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
          model: request.model.modelId,
          messages: chatMessages(request.input),
          stream: true,
          stream_options: { include_usage: true },
          ...(tools.length === 0
            ? {}
            : {
                tools,
                parallel_tool_calls: false,
                ...(request.toolChoice === undefined
                  ? {}
                  : { tool_choice: request.toolChoice }),
              }),
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

    if (finishReason === undefined) {
      throw protocolError();
    }
    const normalizedFinishReason = normalizeFinishReason(finishReason);
    if (
      (toolCall === undefined && normalizedFinishReason === "tool_call") ||
      (toolCall !== undefined && normalizedFinishReason !== "tool_call")
    ) {
      throw protocolError();
    }
    if (toolCall !== undefined) {
      yield { type: "tool_call", ...parseToolCall(toolCall) };
    }
    yield {
      type: "completed",
      finishReason: normalizedFinishReason,
      ...(usage === undefined ? {} : { usage }),
    };
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
    current ??= { index: delta.index, callId: "", name: "", arguments: "" };
    if (delta.id !== undefined) {
      if (current.callId.length > 0 && current.callId !== delta.id) {
        throw protocolError();
      }
      current.callId = delta.id;
    }
    current.name += delta.function?.name ?? "";
    current.arguments += delta.function?.arguments ?? "";
  }
  return current;
}

function parseToolCall(
  call: ToolCallFragments,
): { callId: string; name: string; arguments: JsonValue } {
  if (call.callId.length === 0 || call.name.length === 0) {
    throw protocolError();
  }
  try {
    const argumentsValue = JSON.parse(call.arguments) as unknown;
    if (!isJsonValue(argumentsValue)) {
      throw protocolError();
    }
    return {
      callId: call.callId,
      name: call.name,
      arguments: argumentsValue,
    };
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
  const providerError = findProviderError(error);
  if (providerError !== undefined) return providerError;
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

function findProviderError(error: unknown): ModelProviderError | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    if (current instanceof ModelProviderError) return current;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function exactConnection(
  model: EffectiveModelRuntime,
  connections: Pick<ModelRegistryStore, "getConnectionRevision">,
): ExactProviderConnectionRevision {
  const target = connections.getConnectionRevision(
    model.providerConnectionRevisionId,
  );
  if (
    target === null ||
    target.providerKind !== model.providerKind ||
    target.revision.baseUrl !== model.baseUrl ||
    target.revision.presetVersion !== model.compatibilityPresetVersion ||
    !sameAuth(target.revision.auth, model.providerAuth)
  ) {
    throw protocolError();
  }
  return target;
}

function sameAuth(
  left: ExactProviderConnectionRevision["revision"]["auth"],
  right: EffectiveModelRuntime["providerAuth"],
): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "none" || right.type === "none") return true;
  const leftSecret = left.secret;
  const rightSecret = right.secret;
  if ("fromEnvironment" in leftSecret) {
    return "fromEnvironment" in rightSecret &&
      leftSecret.fromEnvironment === rightSecret.fromEnvironment;
  }
  return "managedSecretVersionId" in rightSecret &&
    leftSecret.managedSecretVersionId === rightSecret.managedSecretVersionId;
}

function chatMessages(input: readonly ModelInput[]): ChatCompletionMessageParam[] {
  return input.map((entry): ChatCompletionMessageParam => {
    if (entry.type === "message") {
      return {
        role: entry.role,
        content: entry.content,
        ...(entry.name === undefined ? {} : { name: entry.name }),
      } as ChatCompletionMessageParam;
    }
    if (entry.type === "assistant_tool_call") {
      return {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: entry.callId,
          type: "function",
          function: {
            name: entry.name,
            arguments: JSON.stringify(entry.arguments),
          },
        }],
      };
    }
    return {
      role: "tool",
      tool_call_id: entry.callId,
      content: JSON.stringify(entry.output),
    };
  });
}

function normalizeFinishReason(value: string): ModelFinishReason {
  switch (value) {
    case "stop":
      return "completed";
    case "tool_calls":
    case "function_call":
      return "tool_call";
    case "length":
    case "content_filter":
      return value;
    default:
      return "unknown";
  }
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
