import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { EnvironmentSecretResolver } from "../../src/adapters/environment-secret-resolver.js";
import { OpenAiResponsesModel } from "../../src/adapters/model/openai-responses.js";
import { NodeProviderHttpTransport } from "../../src/adapters/provider-http-transport.js";
import type { ProviderAuth } from "../../src/domain/provider-connection.js";
import {
  parseProviderConnectionId,
  providerConnectionRevisionIdFromUuid,
} from "../../src/domain/ids.js";
import type { JsonValue } from "../../src/domain/json.js";
import type { ModelChunk, ModelRequest } from "../../src/ports/model.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  })));
});

describe("OpenAiResponsesModel", () => {
  it("reconstructs stateless function call history without previous response state", async () => {
    const fake = await startServer([
      { type: "response.output_text.delta", delta: "ok" },
      { type: "response.completed", response: completedResponse() },
    ]);
    servers.push(fake.server);

    const chunks = await collect(adapter(fake.baseUrl).streamAttempt(request(fake.baseUrl, {
      input: [
        { type: "message", role: "user", content: "Inspect." },
        { type: "assistant_tool_call", callId: "call_7", name: "read_file", arguments: { path: "a.txt" } },
        { type: "tool_result", callId: "call_7", name: "read_file", output: { ok: true } },
      ],
    }), new AbortController().signal));

    expect(chunks).toEqual([
      { type: "text_delta", text: "ok" },
      { type: "completed", finishReason: "completed" },
    ]);
    expect(fake.requests).toHaveLength(1);
    const captured = fake.requests[0]?.body as Record<string, unknown>;
    expect(captured).toMatchObject({
      model: "deepseek-v4-flash",
      store: false,
      stream: true,
      parallel_tool_calls: false,
    });
    expect(captured).not.toHaveProperty("previous_response_id");
    expect(captured.input).toContainEqual({
      type: "function_call_output",
      call_id: "call_7",
      output: '{"ok":true}',
    });
  });

  it("assembles one streamed function call using the provider call ID", async () => {
    const fake = await startServer([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "fc_1",
          type: "function_call",
          call_id: "call_9",
          name: "read_file",
          arguments: "",
          status: "in_progress",
        },
      },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: '{"path":' },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: '"a.txt"}' },
      { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_1", arguments: '{"path":"a.txt"}' },
      { type: "response.completed", response: completedResponse({
        output: [{ id: "fc_1", type: "function_call", call_id: "call_9", name: "read_file", arguments: '{"path":"a.txt"}', status: "completed" }],
      }) },
    ]);
    servers.push(fake.server);

    const chunks = await collect(adapter(fake.baseUrl).streamAttempt(
      request(fake.baseUrl, { input: [{ type: "message", role: "user", content: "Read." }] }),
      new AbortController().signal,
    ));

    expect(chunks).toEqual([
      { type: "tool_call", callId: "call_9", name: "read_file", arguments: { path: "a.txt" } },
      { type: "completed", finishReason: "tool_call" },
    ]);
  });

  it("maps optional terminal Responses usage to canonical usage", async () => {
    const fake = await startServer([
      { type: "response.output_text.delta", delta: "ok" },
      { type: "response.completed", response: completedResponse({
        usage: {
          input_tokens: 12,
          output_tokens: 7,
          total_tokens: 19,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      }) },
    ]);
    servers.push(fake.server);

    const chunks = await collect(adapter(fake.baseUrl).streamAttempt(
      request(fake.baseUrl, { input: [{ type: "message", role: "user", content: "Hello" }] }),
      new AbortController().signal,
    ));

    expect(chunks.at(-1)).toEqual({
      type: "completed",
      finishReason: "completed",
      usage: { inputTokens: 12, outputTokens: 7 },
    });
  });

  it("forces a required tool choice for verification-tool requests", async () => {
    const fake = await startServer([
      { type: "response.output_text.delta", delta: "verified" },
      { type: "response.completed", response: completedResponse() },
    ]);
    servers.push(fake.server);

    await collect(adapter(fake.baseUrl).streamAttempt(request(fake.baseUrl, {
      purpose: "verification_tool",
      toolChoice: "required",
      input: [{ type: "message", role: "user", content: "Verify." }],
    }), new AbortController().signal));

    expect(fake.requests[0]?.body).toMatchObject({ tool_choice: "required" });
  });

  it("rejects a textless non-tool completion as a protocol error", async () => {
    const fake = await startServer([{ type: "response.completed", response: completedResponse() }]);
    servers.push(fake.server);

    await expect(collect(adapter(fake.baseUrl).streamAttempt(
      request(fake.baseUrl, { input: [{ type: "message", role: "user", content: "Hello" }] }),
      new AbortController().signal,
    ))).rejects.toMatchObject({ code: "model_protocol_error", transient: false });
  });

  it.each(["response.failed", "response.incomplete"] as const)("treats %s as a normalized error", async (type) => {
    const fake = await startServer([
      { type: "response.output_text.delta", delta: "partial" },
      {
        type,
        response: completedResponse({
          status: type === "response.failed" ? "failed" : "incomplete",
          error: { code: "raw_secret" },
        }),
      },
      { type: "response.completed", response: completedResponse() },
    ]);
    servers.push(fake.server);

    const error = await collect(adapter(fake.baseUrl).streamAttempt(
      request(fake.baseUrl, { input: [{ type: "message", role: "user", content: "Hello" }] }),
      new AbortController().signal,
    )).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "model_protocol_error", transient: false });
    expect(String(error)).not.toContain("raw_secret");
  });

  it("normalizes a 401 without leaking the provider error body", async () => {
    const fake = await startServer([], {
      status: 401,
      body: { error: { message: "provider-body-secret", code: "raw-code" } },
    });
    servers.push(fake.server);

    const error = await collect(adapter(fake.baseUrl).streamAttempt(
      request(fake.baseUrl, { input: [{ type: "message", role: "user", content: "Hello" }] }),
      new AbortController().signal,
    )).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "provider_auth_failed",
      transient: false,
      status: 401,
    });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain("provider-body-secret");
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain("raw-code");
  });

  it("rejects a function call outside output index zero", async () => {
    const fake = await startServer([{
      type: "response.output_item.added",
      output_index: 1,
      item: {
        id: "fc_2",
        type: "function_call",
        call_id: "call_2",
        name: "read_file",
        arguments: "",
        status: "in_progress",
      },
    }]);
    servers.push(fake.server);

    await expect(collect(adapter(fake.baseUrl).streamAttempt(
      request(fake.baseUrl, { input: [{ type: "message", role: "user", content: "Hello" }] }),
      new AbortController().signal,
    ))).rejects.toMatchObject({ code: "model_protocol_error", transient: false });
  });

  it("rejects multiple streamed function calls", async () => {
    const fake = await startServer([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "one", arguments: "", status: "in_progress" },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { id: "fc_2", type: "function_call", call_id: "call_2", name: "two", arguments: "", status: "in_progress" },
      },
    ]);
    servers.push(fake.server);

    await expect(collect(adapter(fake.baseUrl).streamAttempt(
      request(fake.baseUrl, { input: [{ type: "message", role: "user", content: "Hello" }] }),
      new AbortController().signal,
    ))).rejects.toMatchObject({ code: "model_protocol_error", transient: false });
  });

  it("omits provider reasoning events from canonical output", async () => {
    const fake = await startServer([
      { type: "response.reasoning_text.delta", delta: "provider-reasoning-secret" },
      { type: "response.output_text.delta", delta: "visible" },
      { type: "response.completed", response: completedResponse() },
    ]);
    servers.push(fake.server);

    const chunks = await collect(adapter(fake.baseUrl).streamAttempt(
      request(fake.baseUrl, { input: [{ type: "message", role: "user", content: "Hello" }] }),
      new AbortController().signal,
    ));

    expect(chunks).toEqual([
      { type: "text_delta", text: "visible" },
      { type: "completed", finishReason: "completed" },
    ]);
    expect(JSON.stringify(chunks)).not.toContain("provider-reasoning-secret");
  });

  it.each([
    {
      status: 429,
      headers: { "retry-after": "2" },
      expected: { code: "provider_rate_limited", transient: true, status: 429, retryAfterMs: 2_000 },
    },
    {
      status: 500,
      headers: { "retry-after": "3" },
      expected: { code: "provider_unavailable", transient: true, status: 500, retryAfterMs: 3_000 },
    },
  ])("normalizes safe HTTP $status fields", async ({ status, headers, expected }) => {
    const fake = await startServer([], { status, headers, body: { error: { message: "provider-body-secret" } } });
    servers.push(fake.server);

    const error = await collect(adapter(fake.baseUrl).streamAttempt(
      request(fake.baseUrl, { input: [{ type: "message", role: "user", content: "Hello" }] }),
      new AbortController().signal,
    )).catch((cause: unknown) => cause);

    expect(error).toMatchObject(expected);
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain("provider-body-secret");
  });

  it("normalizes an arbitrary pre-abort reason", async () => {
    const controller = new AbortController();
    controller.abort(new Error("secret-abort-reason"));

    const error = await collect(adapter("http://127.0.0.1:1/v1").streamAttempt(
      request("http://127.0.0.1:1/v1", { input: [{ type: "message", role: "user", content: "Hello" }] }),
      controller.signal,
    )).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ name: "AbortError" });
    expect(String(error)).not.toContain("secret-abort-reason");
  });
});

function adapter(storedBaseUrl: string): OpenAiResponsesModel {
  const revisionId = providerConnectionRevisionIdFromUuid("00000000-0000-7000-8000-000000000401");
  const auth: ProviderAuth = { type: "bearer", secret: { fromEnvironment: "TEST_API_KEY" } };
  return new OpenAiResponsesModel({
    transport: new NodeProviderHttpTransport({
      secretResolver: new EnvironmentSecretResolver({ TEST_API_KEY: "test-key" }),
    }),
    connections: {
      getConnectionRevision(requestedRevisionId) {
        if (requestedRevisionId !== revisionId) return null;
        return {
          providerKind: "openai_compatible",
          revision: {
            revisionId,
            connectionId: parseProviderConnectionId("openai-responses-test"),
            state: "active",
            baseUrl: storedBaseUrl,
            auth,
            allowInsecureHttp: true,
            protocolPreference: "responses",
            presetVersion: "openai-responses-v1",
            createdAt: new Date("2026-08-10T00:00:00.000Z"),
          },
        };
      },
    },
  });
}

function request(
  baseUrl: string,
  options: Pick<ModelRequest, "input"> & Partial<Pick<ModelRequest, "purpose" | "toolChoice">>,
): ModelRequest {
  return {
    purpose: options.purpose ?? "run",
    model: {
      providerConnectionRevisionId: providerConnectionRevisionIdFromUuid("00000000-0000-7000-8000-000000000401"),
      providerKind: "openai_compatible",
      baseUrl,
      providerAuth: { type: "bearer", secret: { fromEnvironment: "TEST_API_KEY" } },
      modelId: "deepseek-v4-flash",
      invocationProtocol: "responses",
      maxInputTokens: 8_192,
      verifiedCapabilities: ["streaming_text", "single_tool_call"],
      compatibilityPresetVersion: "openai-responses-v1",
    },
    input: options.input,
    tools: [{ name: "read_file", description: "Read one file", inputSchema: { type: "object" } }],
    ...(options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice }),
  };
}

async function startServer(
  events: readonly JsonValue[],
  options: { status?: number; body?: JsonValue; headers?: Record<string, string> } = {},
): Promise<{
  server: Server;
  baseUrl: string;
  requests: { body: JsonValue }[];
}> {
  const requests: { body: JsonValue }[] = [];
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      requests.push({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonValue });
      if (options.status !== undefined) {
        response.writeHead(options.status, {
          "content-type": "application/json",
          ...options.headers,
        });
        response.end(JSON.stringify(options.body ?? {}));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${String(address.port)}/v1`, requests };
}

function completedResponse(overrides: Record<string, JsonValue> = {}): JsonValue {
  return {
    id: "resp_test",
    object: "response",
    created_at: 0,
    model: "deepseek-v4-flash",
    status: "completed",
    output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [] }],
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
