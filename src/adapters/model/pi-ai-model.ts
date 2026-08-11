import type { JsonValue } from "../../domain/json.js";
import {
  ModelProviderError,
  type ModelChunk,
  type ModelFinishReason,
  type ModelPort,
  type ModelRequest,
} from "../../ports/model.js";
import type { ProviderEgressGateway } from "../provider-egress-gateway.js";
import type { PiAiClient } from "./pi-ai-client.js";

export interface PiAiModelAdapterOptions {
  client: PiAiClient;
  gateway: Pick<ProviderEgressGateway, "routeFor">;
}

export class PiAiModelAdapter implements ModelPort {
  constructor(private readonly options: PiAiModelAdapterOptions) {}

  async *streamAttempt(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelChunk> {
    if (signal.aborted) throw abortError();
    const contract = request.model.piRuntime;
    if (contract === undefined) throw protocolError();
    const route = this.options.gateway.routeFor(request.model);
    let toolCall: { id: string; name: string; arguments: string } | undefined;
    let terminal: Extract<ModelChunk, { type: "completed" }> | undefined;
    let sawText = false;

    try {
      for await (const event of this.options.client.stream({
        contract,
        route,
        input: request.input,
        tools: request.tools,
        signal,
      })) {
        if (terminal !== undefined) throw protocolError();
        if (event.type === "text_delta") {
          sawText = true;
          yield { type: "text_delta", text: event.text };
        } else if (event.type === "tool_call") {
          if (toolCall === undefined) {
            if (!validToolIdentity(event.id, event.name)) throw protocolError();
            toolCall = { id: event.id, name: event.name, arguments: event.arguments };
          } else {
            if (toolCall.id !== event.id || toolCall.name !== event.name) {
              throw protocolError();
            }
            toolCall.arguments += event.arguments;
          }
        } else if (event.type === "done") {
          if (!isTokenCount(event.usage.inputTokens) || !isTokenCount(event.usage.outputTokens)) {
            throw protocolError();
          }
          const finishReason = finishReasonFromPi(event.reason);
          if (
            (toolCall === undefined && finishReason === "tool_call") ||
            (toolCall !== undefined && finishReason !== "tool_call")
          ) {
            throw protocolError();
          }
          terminal = {
            type: "completed",
            finishReason,
            usage: event.usage,
          };
        } else {
          throw event.reason === "aborted" ? abortError() : providerError(event);
        }
      }
    } catch (error) {
      if (signal.aborted) throw abortError();
      if (error instanceof ModelProviderError || isAbortError(error)) throw error;
      throw new ModelProviderError({ transient: true, code: "provider_unavailable" });
    }

    if (terminal === undefined || (toolCall === undefined && !sawText)) {
      throw protocolError();
    }
    if (toolCall !== undefined) yield { type: "tool_call", ...parseToolCall(toolCall) };
    yield terminal;
  }
}

function parseToolCall(event: {
  id: string;
  name: string;
  arguments: string;
}): { callId: string; name: string; arguments: JsonValue } {
  if (!validToolIdentity(event.id, event.name)) throw protocolError();
  try {
    const parsed = JSON.parse(event.arguments) as unknown;
    if (!isJsonValue(parsed)) throw protocolError();
    return { callId: event.id, name: event.name, arguments: parsed };
  } catch (error) {
    if (error instanceof ModelProviderError) throw error;
    throw protocolError();
  }
}

function validToolIdentity(id: string, name: string): boolean {
  return /^[\x21-\x7e]{1,200}$/u.test(id) && name.length > 0;
}

function finishReasonFromPi(reason: "stop" | "length" | "toolUse"): ModelFinishReason {
  if (reason === "stop") return "completed";
  if (reason === "length") return "length";
  return "tool_call";
}

function providerError(event: {
  status?: number;
  retryAfterMs?: number;
}): ModelProviderError {
  const { status } = event;
  if (status === undefined) {
    return new ModelProviderError({ transient: true, code: "provider_unavailable" });
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
      ...retryAfter(event.retryAfterMs),
    });
  }
  if (status === 408 || status === 425 || status >= 500) {
    return new ModelProviderError({
      transient: true,
      code: "provider_unavailable",
      status,
      ...retryAfter(event.retryAfterMs),
    });
  }
  return new ModelProviderError({
    transient: false,
    code: "model_protocol_error",
    status,
  });
}

function retryAfter(value: number | undefined): { retryAfterMs?: number } {
  return value === undefined || !Number.isFinite(value) || value < 0
    ? {}
    : { retryAfterMs: Math.min(Math.round(value), 30_000) };
}

function protocolError(): ModelProviderError {
  return new ModelProviderError({ transient: false, code: "model_protocol_error" });
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}
