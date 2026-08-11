import { describe, expect, it } from "vitest";

import {
  PiAiSdkClient,
  type PiAiClient,
  type PiStreamEvent,
  type PiSdkStream,
} from "../../src/adapters/model/pi-ai-client.js";
import { PiAiModelAdapter } from "../../src/adapters/model/pi-ai-model.js";
import type { PiGatewayRoute } from "../../src/adapters/provider-egress-gateway.js";
import { providerConnectionRevisionIdFromUuid } from "../../src/domain/ids.js";
import type { ModelChunk, ModelRequest } from "../../src/ports/model.js";

describe("PiAiModelAdapter", () => {
  it("maps Pi text, usage, and one function call into ModelChunk values", async () => {
    const model = new PiAiModelAdapter({
      client: scriptedPiClient([
        { type: "text_delta", text: "hello" },
        {
          type: "tool_call",
          id: "call_1",
          name: "read_file",
          arguments: '{"path":"a.txt"}',
        },
        {
          type: "done",
          reason: "toolUse",
          usage: { inputTokens: 3, outputTokens: 2 },
        },
      ]),
      gateway: gatewayRoute(),
    });

    await expect(collect(model.streamAttempt(piRequest(), signal()))).resolves.toEqual([
      { type: "text_delta", text: "hello" },
      {
        type: "tool_call",
        callId: "call_1",
        name: "read_file",
        arguments: { path: "a.txt" },
      },
      {
        type: "completed",
        finishReason: "tool_call",
        usage: { inputTokens: 3, outputTokens: 2 },
      },
    ]);
  });

  it("passes a tool continuation with its original provider call ID", async () => {
    let capturedInput: ModelRequest["input"] | undefined;
    const client: PiAiClient = {
      async *stream(input) {
        capturedInput = input.input;
        yield { type: "text_delta", text: "done" };
        yield {
          type: "done",
          reason: "stop",
          usage: { inputTokens: 5, outputTokens: 1 },
        };
      },
    };
    const continuation = piRequest({
      input: [
        { type: "message", role: "user", content: "Read it" },
        {
          type: "assistant_tool_call",
          callId: "provider-call-17",
          name: "read_file",
          arguments: { path: "a.txt" },
        },
        {
          type: "tool_result",
          callId: "provider-call-17",
          name: "read_file",
          output: { content: "hello" },
        },
      ],
    });
    const model = new PiAiModelAdapter({ client, gateway: gatewayRoute() });

    await collect(model.streamAttempt(continuation, signal()));

    expect(capturedInput).toEqual(continuation.input);
  });

  it("rejects a second Pi function call before emitting a terminal chunk", async () => {
    const chunks: ModelChunk[] = [];
    const model = new PiAiModelAdapter({
      client: scriptedPiClient([
        { type: "tool_call", id: "call_1", name: "read_file", arguments: "{}" },
        { type: "tool_call", id: "call_2", name: "read_file", arguments: "{}" },
        {
          type: "done",
          reason: "toolUse",
          usage: { inputTokens: 3, outputTokens: 2 },
        },
      ]),
      gateway: gatewayRoute(),
    });

    await expect(drain(model.streamAttempt(piRequest(), signal()), chunks)).rejects.toMatchObject({
      code: "model_protocol_error",
      transient: false,
    });
    expect(chunks).not.toContainEqual(expect.objectContaining({ type: "completed" }));
    expect(chunks).not.toContainEqual(expect.objectContaining({ type: "tool_call" }));
  });

  it("buffers Pi argument fragments by provider call ID into one Tool Call", async () => {
    const model = new PiAiModelAdapter({
      client: scriptedPiClient([
        {
          type: "tool_call",
          id: "provider-call-fragmented",
          name: "read_file",
          arguments: '{"path":',
        },
        {
          type: "tool_call",
          id: "provider-call-fragmented",
          name: "read_file",
          arguments: '"a.txt"}',
        },
        {
          type: "done",
          reason: "toolUse",
          usage: { inputTokens: 3, outputTokens: 2 },
        },
      ]),
      gateway: gatewayRoute(),
    });

    await expect(collect(model.streamAttempt(piRequest(), signal()))).resolves.toEqual([
      {
        type: "tool_call",
        callId: "provider-call-fragmented",
        name: "read_file",
        arguments: { path: "a.txt" },
      },
      {
        type: "completed",
        finishReason: "tool_call",
        usage: { inputTokens: 3, outputTokens: 2 },
      },
    ]);
  });

  it("rejects malformed Pi function arguments before emitting a Tool Call", async () => {
    const chunks: ModelChunk[] = [];
    const model = new PiAiModelAdapter({
      client: scriptedPiClient([
        {
          type: "tool_call",
          id: "call_1",
          name: "read_file",
          arguments: '{"path":',
        },
        {
          type: "done",
          reason: "toolUse",
          usage: { inputTokens: 3, outputTokens: 2 },
        },
      ]),
      gateway: gatewayRoute(),
    });

    await expect(drain(model.streamAttempt(piRequest(), signal()), chunks)).rejects.toMatchObject({
      code: "model_protocol_error",
      transient: false,
    });
    expect(chunks).not.toContainEqual(expect.objectContaining({ type: "tool_call" }));
  });

  it.each([
    [401, "provider_auth_failed", false],
    [400, "model_protocol_error", false],
    [429, "provider_rate_limited", true],
    [503, "provider_unavailable", true],
  ] as const)(
    "maps Pi provider status %i to %s",
    async (status, code, transient) => {
      const model = new PiAiModelAdapter({
        client: scriptedPiClient([{
          type: "error",
          reason: "error",
          status,
          retryAfterMs: 1_500,
        }]),
        gateway: gatewayRoute(),
      });

      await expect(collect(model.streamAttempt(piRequest(), signal()))).rejects.toMatchObject({
        code,
        transient,
        status,
        ...(status === 429 || status === 503 ? { retryAfterMs: 1_500 } : {}),
      });
    },
  );

  it("propagates cancellation before allocating a gateway route", async () => {
    const controller = new AbortController();
    controller.abort();
    let routeCalls = 0;
    const model = new PiAiModelAdapter({
      client: scriptedPiClient([]),
      gateway: {
        routeFor() {
          routeCalls += 1;
          return { baseUrl: "unreachable", apiKey: "unreachable" };
        },
      },
    });

    await expect(collect(model.streamAttempt(piRequest(), controller.signal))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(routeCalls).toBe(0);
  });

  it("maps Pi streaming cancellation to AbortError without a terminal chunk", async () => {
    const chunks: ModelChunk[] = [];
    const model = new PiAiModelAdapter({
      client: scriptedPiClient([
        { type: "text_delta", text: "partial" },
        { type: "error", reason: "aborted" },
      ]),
      gateway: gatewayRoute(),
    });

    await expect(drain(model.streamAttempt(piRequest(), signal()), chunks)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(chunks).toEqual([{ type: "text_delta", text: "partial" }]);
  });

  it("rejects invalid Pi usage instead of emitting a terminal chunk", async () => {
    const chunks: ModelChunk[] = [];
    const model = new PiAiModelAdapter({
      client: scriptedPiClient([
        { type: "text_delta", text: "hello" },
        {
          type: "done",
          reason: "stop",
          usage: { inputTokens: -1, outputTokens: 2 },
        },
      ]),
      gateway: gatewayRoute(),
    });

    await expect(drain(model.streamAttempt(piRequest(), signal()), chunks)).rejects.toMatchObject({
      code: "model_protocol_error",
      transient: false,
    });
    expect(chunks).toEqual([{ type: "text_delta", text: "hello" }]);
  });
});

describe("PiAiSdkClient", () => {
  it("constructs the Pi model and context only from the frozen contract and gateway route", async () => {
    const captured: Array<{ model: unknown; context: unknown; options: unknown }> = [];
    let transformedPayload: unknown;
    const sdkStream: PiSdkStream = async function* (model, context, options) {
      captured.push({ model, context, options });
      transformedPayload = await options?.onPayload?.({
        model: model.id,
        tools: [{ type: "function" }],
      }, model);
      const partial = {
        role: "assistant" as const,
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop" as const,
        timestamp: 0,
      };
      yield { type: "text_delta", contentIndex: 0, delta: "hello", partial };
      yield {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: {
          type: "toolCall",
          id: "provider-call-sdk",
          name: "read_file",
          arguments: { path: "a.txt" },
        },
        partial,
      };
      yield {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          api: "openai-completions",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 0,
        },
      };
    };
    const client = new PiAiSdkClient({ stream: sdkStream });
    const request = piRequest({
      input: [
        { type: "message", role: "system", content: "Be exact." },
        { type: "message", role: "user", content: "Read it" },
        {
          type: "assistant_tool_call",
          callId: "provider-call-17",
          name: "read_file",
          arguments: { path: "a.txt" },
        },
        {
          type: "tool_result",
          callId: "provider-call-17",
          name: "read_file",
          output: { content: "hello" },
        },
      ],
      tools: [{
        name: "read_file",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      }],
      toolChoice: "required",
    });
    const route = { baseUrl: "http://127.0.0.1:43111/pi/capability", apiKey: "capability" };

    const events = await collectPi(client.stream({
      contract: request.model.piRuntime!,
      route,
      input: request.input,
      tools: request.tools,
      signal: signal(),
    }));

    expect(events).toEqual([
      { type: "text_delta", text: "hello" },
      {
        type: "tool_call",
        id: "provider-call-sdk",
        name: "read_file",
        arguments: '{"path":"a.txt"}',
      },
      {
        type: "done",
        reason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    expect(transformedPayload).toEqual({
      model: "deepseek-v4-flash",
      tools: [{ type: "function" }],
      parallel_tool_calls: false,
    });

    expect(captured).toEqual([{
      model: {
        id: "deepseek-v4-flash",
        name: "deepseek-v4-flash",
        api: "openai-completions",
        provider: "deepseek",
        baseUrl: route.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8_192,
        maxTokens: 2_048,
        compat: { supportsUsageInStreaming: true },
      },
      context: {
        systemPrompt: "Be exact.",
        messages: [
          { role: "user", content: "Read it", timestamp: 0 },
          {
            role: "assistant",
            content: [{
              type: "toolCall",
              id: "provider-call-17",
              name: "read_file",
              arguments: { path: "a.txt" },
            }],
            api: "openai-completions",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 0,
          },
          {
            role: "toolResult",
            toolCallId: "provider-call-17",
            toolName: "read_file",
            content: [{ type: "text", text: '{"content":"hello"}' }],
            isError: false,
            timestamp: 0,
          },
        ],
        tools: [{
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        }],
      },
      options: expect.objectContaining({
        apiKey: route.apiKey,
        maxTokens: 2_048,
        maxRetries: 0,
        signal: expect.any(AbortSignal),
      }),
    }]);
  });
});

function piRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    purpose: "run",
    model: {
      providerConnectionRevisionId: providerConnectionRevisionIdFromUuid(
        "00000000-0000-7000-8000-000000000541",
      ),
      providerKind: "openai_compatible",
      baseUrl: "https://provider.example/v1",
      providerAuth: { type: "none" },
      allowInsecureHttp: false,
      modelId: "deepseek-v4-flash",
      invocationProtocol: "chat_completions",
      maxInputTokens: 8_192,
      verifiedCapabilities: ["streaming_text", "single_tool_call"],
      compatibilityPresetVersion: "openai-compatible-v1",
      piRuntime: {
        kind: "pi_ai",
        piVersion: "0.73.1",
        driverId: "pi/deepseek",
        catalogProviderId: "deepseek",
        api: "openai-completions",
        modelId: "deepseek-v4-flash",
        contextWindow: 8_192,
        maxOutputTokens: 2_048,
        compatibility: { supportsUsageInStreaming: true },
      },
    },
    input: [{ type: "message", role: "user", content: "Hello" }],
    tools: [],
    ...overrides,
  };
}

function scriptedPiClient(events: readonly PiStreamEvent[]): PiAiClient {
  return {
    async *stream() {
      for (const event of events) yield event;
    },
  };
}

function gatewayRoute(route: PiGatewayRoute = {
  baseUrl: "http://127.0.0.1:43111/pi/capability",
  apiKey: "capability",
}): { routeFor(request: ModelRequest["model"]): PiGatewayRoute } {
  return { routeFor: () => route };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function collect(stream: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

async function drain(stream: AsyncIterable<ModelChunk>, chunks: ModelChunk[]): Promise<void> {
  for await (const chunk of stream) chunks.push(chunk);
}

async function collectPi(stream: AsyncIterable<PiStreamEvent>): Promise<PiStreamEvent[]> {
  const events: PiStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
