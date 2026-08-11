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
import type { ModelInput, ModelRequest } from "../../ports/model.js";
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
      maxRetries: 0,
      onPayload: (payload) => disableParallelToolCalls(input.contract.api, payload),
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
            inputTokens: event.message.usage.input,
            outputTokens: event.message.usage.output,
          },
        };
      } else if (event.type === "error") {
        yield {
          type: "error",
          reason: event.reason,
          ...(status === undefined ? {} : { status }),
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
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

function disableParallelToolCalls(api: string, payload: unknown): unknown | undefined {
  if (
    api !== "openai-completions" &&
    api !== "openai-responses" &&
    api !== "openai-codex-responses"
  ) {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null || !("tools" in payload)) {
    return undefined;
  }
  return { ...payload, parallel_tool_calls: false };
}

function parseRetryAfter(headers: Record<string, string>): number | undefined {
  const value = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "retry-after",
  )?.[1];
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1_000);
}
