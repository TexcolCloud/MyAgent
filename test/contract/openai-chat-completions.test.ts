import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { EnvironmentSecretResolver } from "../../src/adapters/environment-secret-resolver.js";
import { OpenAiChatCompletionsModel } from "../../src/adapters/model/openai-chat-completions.js";
import type { JsonValue } from "../../src/domain/json.js";
import type { ModelChunk, ModelRequest } from "../../src/ports/model.js";

describe("OpenAiChatCompletionsModel", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error === undefined ? resolve() : reject(error)));
          }),
      ),
    );
  });

  it("streams text and reports final usage from one provider attempt", async () => {
    const fake = await startServer([
      frame({ content: "Hel" }),
      frame({ content: "lo" }),
      frame({}, "stop"),
      usageFrame(11, 3),
    ]);
    servers.push(fake.server);
    const model = adapter();

    const chunks = await collect(
      model.streamAttempt(request(fake.baseUrl), new AbortController().signal),
    );

    expect(chunks).toEqual([
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      {
        type: "completed",
        finishReason: "stop",
        usage: { inputTokens: 11, outputTokens: 3 },
      },
    ]);
    expect(fake.requests[0]).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      parallel_tool_calls: false,
    });
  });

  it.each([
    {
      name: "finish reason",
      events: [frame({ content: "incomplete" }), usageFrame(3, 1)],
    },
    {
      name: "usage",
      events: [frame({ content: "incomplete" }), frame({}, "stop")],
    },
  ])("rejects a stream missing final $name", async ({ events }) => {
    const fake = await startServer(events);
    servers.push(fake.server);

    await expect(
      collect(
        adapter().streamAttempt(
          request(fake.baseUrl),
          new AbortController().signal,
        ),
      ),
    ).rejects.toMatchObject({ code: "model_protocol_error", transient: false });
  });

  it("omits Tool-only request fields when no Tools are available", async () => {
    const fake = await startServer([
      frame({ content: "summary" }),
      frame({}, "stop"),
      usageFrame(3, 1),
    ]);
    servers.push(fake.server);

    await collect(
      adapter().streamAttempt(
        { ...request(fake.baseUrl), purpose: "session_summary", tools: [] },
        new AbortController().signal,
      ),
    );

    expect(fake.requests[0]).not.toHaveProperty("tools");
    expect(fake.requests[0]).not.toHaveProperty("parallel_tool_calls");
  });

  it("assembles one fragmented Tool Call", async () => {
    const fake = await startServer([
      frame({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "read_", arguments: '{"pa' },
          },
        ],
      }),
      frame({
        tool_calls: [
          {
            index: 0,
            function: { name: "file", arguments: 'th":"report.md"}' },
          },
        ],
      }),
      frame({}, "tool_calls"),
      usageFrame(20, 5),
    ]);
    servers.push(fake.server);

    const chunks = await collect(
      adapter().streamAttempt(
        request(fake.baseUrl),
        new AbortController().signal,
      ),
    );

    expect(chunks).toContainEqual({
      type: "tool_call",
      call: { name: "read_file", arguments: { path: "report.md" } },
    });
  });

  it.each([
    {
      name: "malformed arguments",
      events: [
        frame({
          tool_calls: [
            {
              index: 0,
              function: { name: "read_file", arguments: '{"path":' },
            },
          ],
        }),
        frame({}, "tool_calls"),
        usageFrame(1, 1),
      ],
    },
    {
      name: "multiple Tool Calls",
      events: [
        frame({
          tool_calls: [
            { index: 0, function: { name: "one", arguments: "{}" } },
            { index: 1, function: { name: "two", arguments: "{}" } },
          ],
        }),
      ],
    },
  ])("rejects $name as a model protocol error", async ({ events }) => {
    const fake = await startServer(events);
    servers.push(fake.server);

    await expect(
      collect(
        adapter().streamAttempt(
          request(fake.baseUrl),
          new AbortController().signal,
        ),
      ),
    ).rejects.toMatchObject({ code: "model_protocol_error", transient: false });
  });

  it("maps 429 Retry-After without exposing the provider body", async () => {
    const fake = await startServer([], {
      status: 429,
      headers: { "retry-after": "2" },
      body: {
        error: {
          message: "provider-body-secret",
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
        },
      },
    });
    servers.push(fake.server);

    const error = await collect(
      adapter().streamAttempt(
        request(fake.baseUrl),
        new AbortController().signal,
      ),
    ).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "rate_limit_exceeded",
      transient: true,
      status: 429,
      retryAfterMs: 2_000,
    });
    expect(String(error)).not.toContain("provider-body-secret");
  });

  it("maps an HTTP-date Retry-After", async () => {
    const fake = await startServer([], {
      status: 503,
      headers: { "retry-after": new Date(Date.now() + 10_000).toUTCString() },
      body: { error: { code: "server_error" } },
    });
    servers.push(fake.server);

    const error = await collect(
      adapter().streamAttempt(
        request(fake.baseUrl),
        new AbortController().signal,
      ),
    ).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "server_error", transient: true });
    expect(error).toMatchObject({ retryAfterMs: expect.any(Number) });
    expect((error as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
  });

  it("honors an already-aborted attempt", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(
      collect(
        adapter().streamAttempt(
          request("http://127.0.0.1:1/v1"),
          controller.signal,
        ),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

function adapter(): OpenAiChatCompletionsModel {
  return new OpenAiChatCompletionsModel({
    secretResolver: new EnvironmentSecretResolver({ TEST_API_KEY: "test-key" }),
  });
}

function request(baseUrl: string): ModelRequest {
  return {
    purpose: "run",
    model: {
      provider: "openai-compatible",
      model: "test-model",
      baseUrl,
      apiKey: { fromEnvironment: "TEST_API_KEY" },
      maxInputTokens: 8_192,
    },
    messages: [
      { role: "system", name: "runtime_safety", content: "Follow policy." },
      { role: "user", name: "operator", content: "Read the report." },
    ],
    tools: [
      {
        name: "read_file",
        description: "Read one file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
  };
}

interface FakeServerOptions {
  status: number;
  headers?: Record<string, string>;
  body: JsonValue;
}

async function startServer(
  events: readonly JsonValue[],
  options?: FakeServerOptions,
): Promise<{ server: Server; baseUrl: string; requests: JsonValue[] }> {
  const requests: JsonValue[] = [];
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonValue);
      if (options !== undefined) {
        response.writeHead(options.status, {
          "content-type": "application/json",
          ...options.headers,
        });
        response.end(JSON.stringify(options.body));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events) {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
  };
}

function frame(delta: JsonValue, finishReason: string | null = null): JsonValue {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    usage: null,
  };
}

function usageFrame(inputTokens: number, outputTokens: number): JsonValue {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices: [],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

async function collect(stream: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}
