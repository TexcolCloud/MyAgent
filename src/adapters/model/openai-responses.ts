import canonicalizeModule from "canonicalize";
import OpenAI from "openai";
import type {
  FunctionTool,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";

import type { JsonValue } from "../../domain/json.js";
import {
  ModelProviderError,
  type ModelChunk,
  type ModelInput,
  type ModelPort,
  type ModelRequest,
  type ModelUsage,
} from "../../ports/model.js";
import type { ProviderHttpTransport } from "../../ports/provider-http-transport.js";
import { providerRuntimeConnection } from "./provider-runtime-connection.js";

export interface OpenAiResponsesModelOptions {
  transport: ProviderHttpTransport;
}

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 16 * 1_024 * 1_024;
const MAX_RETRY_AFTER_MS = 30_000;
const canonicalizeJson = canonicalizeModule as unknown as (
  input: unknown,
) => string | undefined;

interface FunctionCallFragments {
  outputIndex: number;
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
  argumentsDone: boolean;
  itemDone: boolean;
}

export class OpenAiResponsesModel implements ModelPort {
  constructor(private readonly options: OpenAiResponsesModelOptions) {}

  async *streamAttempt(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelChunk> {
    if (signal.aborted) throw abortError();
    if (request.model.invocationProtocol !== "responses") {
      throw new ModelProviderError({
        transient: false,
        code: "invocation_protocol_unsupported",
      });
    }
    const client = new OpenAI({
      apiKey: "transport-owned-authentication",
      baseURL: request.model.baseUrl,
      maxRetries: 0,
      fetch: this.options.transport.createFetch({
        connection: providerRuntimeConnection(request.model),
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
      }),
    });
    try {
      const stream = await client.responses.create({
        model: request.model.modelId,
        input: responseInput(request.input),
        tools: responseTools(request),
        store: false,
        stream: true,
        parallel_tool_calls: false,
        ...(request.purpose === "verification_tool" && request.toolChoice === "required"
          ? { tool_choice: "required" as const }
          : {}),
      } satisfies ResponseCreateParamsStreaming, { signal });

      let functionCall: FunctionCallFragments | undefined;
      let sawText = false;
      for await (const event of stream) {
        if (event.type === "response.failed" || event.type === "response.incomplete") {
          throw protocolError();
        }
        if (event.type === "response.output_text.delta" && event.delta.length > 0) {
          sawText = true;
          yield { type: "text_delta", text: event.delta };
        }
        functionCall = appendFunctionCall(functionCall, event);
        if (event.type === "response.completed") {
          if (event.response.status !== "completed") throw protocolError();
          reconcileTerminalOutput(event.response.output, functionCall);
          if (functionCall === undefined && !sawText) throw protocolError();
          if (functionCall !== undefined) {
            yield { type: "tool_call", ...parseFunctionCall(functionCall) };
          }
          const usage = mapUsage(event.response.usage);
          yield {
            type: "completed",
            finishReason: functionCall === undefined ? "completed" : "tool_call",
            ...(usage === undefined ? {} : { usage }),
          };
          return;
        }
      }
      throw protocolError();
    } catch (error) {
      throw toModelProviderError(error, signal);
    }
  }
}

function mapUsage(value: unknown): ModelUsage | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object") throw protocolError();
  const usage = value as Record<string, unknown>;
  if (!isTokenCount(usage.input_tokens) || !isTokenCount(usage.output_tokens)) {
    throw protocolError();
  }
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function toModelProviderError(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) return abortError();
  const providerError = findProviderError(error);
  if (providerError !== undefined) return providerError;
  if (error instanceof OpenAI.APIError) {
    return safeStatusError(error.status, error.headers);
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

function safeStatusError(
  status: number | undefined,
  headers: Headers | undefined,
): ModelProviderError {
  if (status === undefined) {
    return new ModelProviderError({ transient: true, code: "provider_unavailable" });
  }
  if (status === 401 || status === 403) {
    return new ModelProviderError({ transient: false, code: "provider_auth_failed", status });
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
  return new ModelProviderError({ transient: false, code: "model_protocol_error", status });
}

function retryAfter(headers: Headers | undefined): { retryAfterMs?: number } {
  const value = headers?.get("retry-after");
  if (value === null || value === undefined) return {};
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return { retryAfterMs: Math.min(Math.round(seconds * 1_000), MAX_RETRY_AFTER_MS) };
  }
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt)
    ? { retryAfterMs: Math.min(Math.max(0, retryAt - Date.now()), MAX_RETRY_AFTER_MS) }
    : {};
}

function appendFunctionCall(
  current: FunctionCallFragments | undefined,
  event: ResponseStreamEvent,
): FunctionCallFragments | undefined {
  if (event.type === "response.output_item.added") {
    const item = event.item;
    if (!isDeclaredFunctionCall(item)) return current;
    if (
      !isOutputIndex(event.output_index) ||
      !isFunctionCallItem(item) ||
      item.status !== "in_progress"
    ) {
      throw protocolError();
    }
    if (current !== undefined) throw protocolError();
    return {
      outputIndex: event.output_index,
      itemId: item.id,
      callId: item.call_id,
      name: item.name,
      arguments: item.arguments,
      argumentsDone: false,
      itemDone: false,
    };
  }
  if (event.type === "response.function_call_arguments.delta") {
    if (
      current === undefined ||
      event.output_index !== current.outputIndex ||
      event.item_id !== current.itemId ||
      typeof event.delta !== "string" ||
      current.argumentsDone
    ) {
      throw protocolError();
    }
    current.arguments += event.delta;
    return current;
  }
  if (event.type === "response.function_call_arguments.done") {
    if (
      current === undefined ||
      event.output_index !== current.outputIndex ||
      event.item_id !== current.itemId ||
      typeof event.arguments !== "string" ||
      current.argumentsDone ||
      current.arguments !== event.arguments
    ) {
      throw protocolError();
    }
    current.argumentsDone = true;
  }
  if (event.type === "response.output_item.done") {
    const item = event.item;
    if (!isDeclaredFunctionCall(item)) return current;
    if (
      !isFunctionCallItem(item) ||
      item.status !== "completed" ||
      current === undefined ||
      current.itemDone ||
      !current.argumentsDone ||
      event.output_index !== current.outputIndex ||
      !sameFunctionCall(current, item)
    ) {
      throw protocolError();
    }
    current.itemDone = true;
  }
  return current;
}

function isDeclaredFunctionCall(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>).type === "function_call";
}

function isOutputIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFunctionCallItem(value: unknown): value is {
  id: string;
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  status?: unknown;
} {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return item.type === "function_call" &&
    typeof item.id === "string" && item.id.length > 0 &&
    typeof item.call_id === "string" && isCallId(item.call_id) &&
    typeof item.name === "string" && item.name.length > 0 &&
    typeof item.arguments === "string";
}

function sameFunctionCall(
  current: FunctionCallFragments,
  item: { id: string; call_id: string; name: string; arguments: string },
): boolean {
  return current.itemId === item.id &&
    current.callId === item.call_id &&
    current.name === item.name &&
    current.arguments === item.arguments;
}

function reconcileTerminalOutput(
  output: unknown,
  current: FunctionCallFragments | undefined,
): void {
  if (!Array.isArray(output)) throw protocolError();
  let terminalFunctionCall: FunctionCallFragments | undefined;
  for (let index = 0; index < output.length; index += 1) {
    const item = output[index];
    if (!isDeclaredFunctionCall(item)) continue;
    if (
      !isFunctionCallItem(item) ||
      item.status !== "completed" ||
      current === undefined ||
      terminalFunctionCall !== undefined ||
      index !== current.outputIndex ||
      !sameFunctionCall(current, item)
    ) {
      throw protocolError();
    }
    terminalFunctionCall = current;
  }
  if (current !== undefined &&
    (!current.argumentsDone || !current.itemDone || terminalFunctionCall === undefined)) {
    throw protocolError();
  }
}

function parseFunctionCall(call: FunctionCallFragments): {
  callId: string;
  name: string;
  arguments: JsonValue;
} {
  if (!call.argumentsDone || call.arguments.length === 0) throw protocolError();
  try {
    const argumentsValue = JSON.parse(call.arguments) as unknown;
    if (!isJsonValue(argumentsValue)) throw protocolError();
    return { callId: call.callId, name: call.name, arguments: argumentsValue };
  } catch (error) {
    if (error instanceof ModelProviderError) throw error;
    throw protocolError();
  }
}

function responseTools(request: ModelRequest): FunctionTool[] {
  return request.tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as { [key: string]: unknown },
    strict: true,
  }));
}

function responseInput(input: readonly ModelInput[]): ResponseInput {
  const result: ResponseInput = [];
  for (let index = 0; index < input.length; index += 1) {
    const entry = input[index] as ModelInput;
    if (entry.type === "message") {
      result.push({
        type: "message",
        role: entry.role,
        content: entry.content,
      });
      continue;
    }
    if (entry.type === "tool_result") throw protocolError();
    const toolResult = input[index + 1];
    if (
      toolResult === undefined ||
      toolResult.type !== "tool_result" ||
      toolResult.callId !== entry.callId ||
      toolResult.name !== entry.name ||
      !isCallId(entry.callId)
    ) {
      throw protocolError();
    }
    result.push({
      type: "function_call",
      call_id: entry.callId,
      name: entry.name,
      arguments: canonicalJson(entry.arguments),
    });
    result.push({
      type: "function_call_output",
      call_id: toolResult.callId,
      output: canonicalJson(toolResult.output),
    });
    index += 1;
  }
  return result;
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

function isCallId(value: string): boolean {
  return /^[\x21-\x7e]{1,200}$/.test(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && Object.values(value).every(isJsonValue);
}

function protocolError(): ModelProviderError {
  return new ModelProviderError({ transient: false, code: "model_protocol_error" });
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}
