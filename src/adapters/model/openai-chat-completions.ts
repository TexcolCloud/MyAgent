import canonicalizeModule from "canonicalize";
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
const MAX_RETRY_AFTER_MS = 30_000;
const canonicalizeJson = canonicalizeModule as unknown as (
  input: unknown,
) => string | undefined;

export class OpenAiChatCompletionsModel implements ModelPort {
  constructor(private readonly options: OpenAiChatCompletionsModelOptions) {}

  async *streamAttempt(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelChunk> {
    if (signal.aborted) throw abortError();
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
    let usageSeen = false;
    let sawText = false;

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
                ...(request.purpose === "verification_tool" &&
                    request.toolChoice === "required"
                  ? { tool_choice: "required" as const }
                  : {}),
              }),
        },
        { signal },
      );

      for await (const chunk of stream) {
        if (chunk.choices.length > 1) throw protocolError();
        const choice = chunk.choices[0];
        const hasUsage = chunk.usage !== null && chunk.usage !== undefined;
        if (choice === undefined) {
          if (!hasUsage || finishReason === undefined || usageSeen) {
            throw protocolError();
          }
          usage = mapUsage(chunk);
          usageSeen = true;
          continue;
        }
        if (finishReason !== undefined || choice.index !== 0) {
          throw protocolError();
        }
        if (hasUsage) {
          if (choice.finish_reason === null || usageSeen) throw protocolError();
          usage = mapUsage(chunk);
          usageSeen = true;
        }
        if (
          choice.delta.content !== null &&
          choice.delta.content !== undefined &&
          choice.delta.content.length > 0
        ) {
          sawText = true;
          yield { type: "text_delta", text: choice.delta.content };
        }
        toolCall = appendToolCall(toolCall, choice);
        if (choice.finish_reason !== null) {
          finishReason = choice.finish_reason;
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
      (toolCall !== undefined && normalizedFinishReason !== "tool_call") ||
      (toolCall === undefined && !sawText)
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
  const deltas = choice.delta.tool_calls ?? [];
  if (deltas.length > 1) throw protocolError();
  const delta = deltas[0];
  if (delta === undefined) return current;
  if (delta.index !== 0) throw protocolError();
  if (current === undefined) {
    if (
      delta.type !== "function" ||
      delta.id === undefined ||
      delta.id.length === 0 ||
      delta.function?.name === undefined ||
      delta.function.name.length === 0
    ) {
      throw protocolError();
    }
    current = { index: 0, callId: "", name: "", arguments: "" };
  } else if (delta.type !== undefined && delta.type !== "function") {
    throw protocolError();
  }
  if (delta.id !== undefined && delta.id.length > 0) {
    if (delta.id === current.callId) throw protocolError();
    current.callId += delta.id;
  }
  if (delta.function?.name !== undefined && delta.function.name.length > 0) {
    if (delta.function.name === current.name) throw protocolError();
    current.name += delta.function.name;
  }
  if (
    delta.function?.arguments !== undefined &&
    delta.function.arguments.length > 0
  ) {
    current.arguments += delta.function.arguments;
  }
  return current;
}

function parseToolCall(
  call: ToolCallFragments,
): { callId: string; name: string; arguments: JsonValue } {
  if (
    !/^[\x21-\x7e]{1,200}$/.test(call.callId) ||
    call.name.length === 0 ||
    call.arguments.length === 0
  ) {
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

function mapUsage(chunk: ChatCompletionChunk): ModelUsage {
  if (chunk.usage === null || chunk.usage === undefined) {
    throw protocolError();
  }
  const inputTokens: unknown = chunk.usage.prompt_tokens;
  const outputTokens: unknown = chunk.usage.completion_tokens;
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens)) {
    throw protocolError();
  }
  return {
    inputTokens,
    outputTokens,
  };
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function toModelProviderError(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) {
    return abortError();
  }
  const providerError = findProviderError(error);
  if (providerError !== undefined) return providerError;
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    return safeStatusError(status, error.headers);
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
  const messages: ChatCompletionMessageParam[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const entry = input[index] as ModelInput;
    if (entry.type === "message") {
      messages.push({
        role: entry.role,
        content: entry.content,
        ...(entry.name === undefined ? {} : { name: entry.name }),
      } as ChatCompletionMessageParam);
      continue;
    }
    if (entry.type === "tool_result") throw protocolError();
    const result = input[index + 1];
    if (
      result === undefined ||
      result.type !== "tool_result" ||
      result.callId !== entry.callId ||
      result.name !== entry.name ||
      !/^[\x21-\x7e]{1,200}$/.test(entry.callId)
    ) {
      throw protocolError();
    }
    messages.push({
      role: "assistant",
      tool_calls: [{
        id: entry.callId,
        type: "function",
        function: {
          name: entry.name,
          arguments: canonicalJson(entry.arguments),
        },
      }],
    });
    messages.push({
      role: "tool",
      tool_call_id: result.callId,
      content: canonicalJson(result.output),
    });
    index += 1;
  }
  return messages;
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

function safeStatusError(
  status: number | undefined,
  headers: Headers | undefined,
): ModelProviderError {
  if (status === undefined) {
    return new ModelProviderError({
      transient: true,
      code: "provider_unavailable",
    });
  }
  if (status === 401 || status === 403) {
    return new ModelProviderError({
      transient: false,
      code: "provider_auth_failed",
      status,
    });
  }
  if (status === 429) {
    return new ModelProviderError({
      transient: true,
      code: "provider_rate_limited",
      status,
      ...retryAfter(headers),
    });
  }
  if (status === 408 || status === 425 || status >= 500) {
    return new ModelProviderError({
      transient: true,
      code: "provider_unavailable",
      status,
      ...retryAfter(headers),
    });
  }
  return new ModelProviderError({
    transient: false,
    code: "model_protocol_error",
    status,
  });
}

function retryAfter(headers: Headers | undefined): { retryAfterMs?: number } {
  const value = headers?.get("retry-after");
  if (value === null || value === undefined) {
    return {};
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return { retryAfterMs: Math.min(Math.round(seconds * 1_000), MAX_RETRY_AFTER_MS) };
  }
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt)
    ? { retryAfterMs: Math.min(Math.max(0, retryAt - Date.now()), MAX_RETRY_AFTER_MS) }
    : {};
}

function canonicalJson(value: JsonValue): string {
  try {
    const encoded = canonicalizeJson(value);
    if (encoded !== undefined) return encoded;
  } catch {
    // Canonical input failures are local protocol errors, never provider outages.
  }
  throw protocolError();
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
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
