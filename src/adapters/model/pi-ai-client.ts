import {
  stream as streamPi,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type ProviderStreamOptions,
  type Tool,
} from "@mariozechner/pi-ai";

import type { JsonValue } from "../../domain/json.js";
import type { PiRuntimeContract } from "../../domain/pi-runtime.js";
import { ModelProviderError, type ModelInput, type ModelRequest } from "../../ports/model.js";
import type { PiGatewayRoute } from "../provider-egress-gateway.js";

export type PiStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | {
      type: "done";
      reason: "stop" | "length" | "toolUse";
      usage: { inputTokens: number; outputTokens: number };
    }
  | {
      type: "error";
      reason: "aborted" | "error";
      status?: number;
      retryAfterMs?: number;
    };

export interface PiAiClient {
  stream(input: {
    contract: PiRuntimeContract;
    route: PiGatewayRoute;
    input: readonly ModelInput[];
    tools: ModelRequest["tools"];
    toolChoice: ModelRequest["toolChoice"];
    signal: AbortSignal;
  }): AsyncIterable<PiStreamEvent>;
}

export type PiSdkStream = (
  model: Model<Api>,
  context: Context,
  options?: ProviderStreamOptions,
) => AsyncIterable<AssistantMessageEvent>;

export interface PiAiSdkClientOptions {
  stream?: PiSdkStream;
}

export class PiAiSdkClient implements PiAiClient {
  private readonly streamPi: PiSdkStream;

  constructor(options: PiAiSdkClientOptions = {}) {
    this.streamPi = options.stream ?? streamPi;
  }

  async *stream(input: {
    contract: PiRuntimeContract;
    route: PiGatewayRoute;
    input: readonly ModelInput[];
    tools: ModelRequest["tools"];
    toolChoice: ModelRequest["toolChoice"];
    signal: AbortSignal;
  }): AsyncIterable<PiStreamEvent> {
    const model = piModel(input.contract, input.route);
    let status: number | undefined;
    let retryAfterMs: number | undefined;
    const events = this.streamPi(model, piContext(input.contract, input.input, input.tools), {
      apiKey: input.route.apiKey,
      signal: input.signal,
      ...(input.contract.maxOutputTokens === undefined
        ? {}
        : { maxTokens: input.contract.maxOutputTokens }),
      ...(input.toolChoice === undefined ? {} : { toolChoice: input.toolChoice }),
      maxRetries: 0,
      onPayload: (payload) => transformPayload(input.contract, payload),
      onResponse(response) {
        status = response.status;
        retryAfterMs = parseRetryAfter(response.headers);
      },
    });

    for await (const event of events) {
      if (event.type === "text_delta") {
        if (event.delta.length > 0) yield { type: "text_delta", text: event.delta };
      } else if (event.type === "toolcall_end") {
        yield {
          type: "tool_call",
          id: event.toolCall.id,
          name: event.toolCall.name,
          arguments: JSON.stringify(event.toolCall.arguments),
        };
      } else if (event.type === "done") {
        yield {
          type: "done",
          reason: event.reason,
          usage: {
            inputTokens: totalInputTokens(event.message.usage),
            outputTokens: event.message.usage.output,
          },
        };
      } else if (event.type === "error") {
        const metadata = gatewayErrorMetadata(event.error.errorMessage);
        yield {
          type: "error",
          reason: event.reason,
          ...(status === undefined
            ? metadata?.status === undefined ? {} : { status: metadata.status }
            : { status }),
          ...(retryAfterMs === undefined
            ? metadata?.retryAfterMs === undefined ? {} : { retryAfterMs: metadata.retryAfterMs }
            : { retryAfterMs }),
        };
      }
    }
  }
}

function piModel(contract: PiRuntimeContract, route: PiGatewayRoute): Model<Api> {
  return {
    id: contract.modelId,
    name: contract.modelId,
    api: contract.api,
    provider: contract.catalogProviderId,
    baseUrl: route.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: contract.contextWindow,
    maxTokens: contract.maxOutputTokens ?? contract.contextWindow,
    compat: contract.compatibility,
  } as Model<Api>;
}

function piContext(
  contract: PiRuntimeContract,
  input: readonly ModelInput[],
  tools: ModelRequest["tools"],
): Context {
  if (!isValidPiContextInput(input)) throw protocolError();
  const systemPrompts: string[] = [];
  const messages: Context["messages"] = [];
  for (const entry of input) {
    if (entry.type === "message" && entry.role === "system") {
      systemPrompts.push(entry.content);
    } else if (entry.type === "message" && entry.role === "user") {
      messages.push({ role: "user", content: entry.content, timestamp: 0 });
    } else if (entry.type === "message") {
      messages.push(assistantMessage(contract, [{ type: "text", text: entry.content }], "stop"));
    } else if (entry.type === "assistant_tool_call") {
      messages.push(assistantMessage(contract, [{
        type: "toolCall",
        id: entry.callId,
        name: entry.name,
        arguments: entry.arguments as Record<string, JsonValue>,
      }], "toolUse"));
    } else {
      messages.push({
        role: "toolResult",
        toolCallId: entry.callId,
        toolName: entry.name,
        content: [{ type: "text", text: JSON.stringify(entry.output) }],
        isError: false,
        timestamp: 0,
      });
    }
  }
  return {
    ...(systemPrompts.length === 0 ? {} : { systemPrompt: systemPrompts.join("\n\n") }),
    messages,
    ...(tools.length === 0
      ? {}
      : {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema as Tool["parameters"],
          })),
        }),
  };
}

export function isValidPiContextInput(input: readonly ModelInput[]): boolean {
  for (let index = 0; index < input.length; index += 1) {
    const entry = input[index] as ModelInput;
    if (entry.type === "message") continue;
    if (entry.type === "tool_result") return false;
    const result = input[index + 1];
    if (
      result === undefined ||
      result.type !== "tool_result" ||
      result.callId !== entry.callId ||
      result.name !== entry.name ||
      !isToolCallId(entry.callId) ||
      !isRecord(entry.arguments)
    ) {
      return false;
    }
    index += 1;
  }
  return true;
}

function assistantMessage(
  contract: PiRuntimeContract,
  content: AssistantMessage["content"],
  stopReason: "stop" | "toolUse",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: contract.api,
    provider: contract.catalogProviderId,
    model: contract.modelId,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}

function transformPayload(
  contract: PiRuntimeContract,
  payload: unknown,
): unknown | undefined {
  if (
    contract.api !== "openai-completions" &&
    contract.api !== "openai-responses" &&
    contract.api !== "openai-codex-responses"
  ) {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const sanitized = contract.driverId === "pi/openai-compatible" &&
      contract.api === "openai-responses"
    ? omitManualResponsesCompatibilityFields(payload)
    : payload;
  if (!("tools" in sanitized)) return sanitized === payload ? undefined : sanitized;
  return { ...sanitized, parallel_tool_calls: false };
}

function omitManualResponsesCompatibilityFields(
  payload: object,
): Record<string, unknown> {
  const sanitized = { ...payload } as Record<string, unknown>;
  delete sanitized.store;
  if (Array.isArray(sanitized.tools)) {
    sanitized.tools = sanitized.tools.map((tool) => {
      if (typeof tool !== "object" || tool === null || Array.isArray(tool)) return tool;
      const sanitizedTool = { ...tool } as Record<string, unknown>;
      delete sanitizedTool.strict;
      return sanitizedTool;
    });
  }
  return sanitized;
}

function parseRetryAfter(headers: Record<string, string>): number | undefined {
  const value = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "retry-after",
  )?.[1];
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  const milliseconds = Math.round(seconds * 1_000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function totalInputTokens(usage: {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}): number {
  if (!isTokenCount(usage.input) || !isTokenCount(usage.cacheRead) || !isTokenCount(usage.cacheWrite)) {
    throw protocolError();
  }
  const total = usage.input + usage.cacheRead + usage.cacheWrite;
  if (!Number.isSafeInteger(total)) throw protocolError();
  return total;
}

function gatewayErrorMetadata(errorMessage: string | undefined): {
  status?: number;
  retryAfterMs?: number;
} | undefined {
  if (errorMessage === undefined) return undefined;
  const match = /\bpi_gateway_error status=([1-5]\d{2})(?: retry_after_ms=(\d+))?\b/u.exec(
    errorMessage,
  );
  if (match?.[1] === undefined) return undefined;
  const status = Number(match[1]);
  const retryAfterMs = match[2] === undefined ? undefined : Number(match[2]);
  return {
    status,
    ...(retryAfterMs === undefined || !Number.isSafeInteger(retryAfterMs)
      ? {}
      : { retryAfterMs }),
  };
}

function isToolCallId(value: string): boolean {
  return /^[\x21-\x7e]{1,200}$/u.test(value);
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function protocolError(): ModelProviderError {
  return new ModelProviderError({ transient: false, code: "model_protocol_error" });
}
