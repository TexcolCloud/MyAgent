import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { EnvironmentSecretResolver } from "../../src/adapters/environment-secret-resolver.js";
import { OpenAiChatCompletionsModel } from "../../src/adapters/model/openai-chat-completions.js";
import { NodeProviderHttpTransport } from "../../src/adapters/provider-http-transport.js";
import {
  parseProviderConnectionId,
  providerConnectionRevisionIdFromUuid,
} from "../../src/domain/ids.js";
import type { JsonValue } from "../../src/domain/json.js";
import type { ProviderAuth } from "../../src/domain/provider-connection.js";
import type { ModelChunk, ModelRequest } from "../../src/ports/model.js";
import type { ProviderHttpTransport } from "../../src/ports/provider-http-transport.js";

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

  it("maps all message roles and a paired Tool continuation with canonical JSON", async () => {
    const fake = await startServer(successEvents());
    servers.push(fake.server);
    const input: ModelRequest["input"] = [
      { type: "message", role: "system", name: "safety", content: "Policy" },
      { type: "message", role: "user", name: "operator", content: "Continue" },
      { type: "message", role: "assistant", name: "assistant", content: "Calling a Tool" },
      {
        type: "assistant_tool_call",
        callId: "call_7",
        name: "read_file",
        arguments: { z: 1, path: "a" },
      },
      {
        type: "tool_result",
        callId: "call_7",
        name: "read_file",
        output: { z: false, ok: true },
      },
    ];

    await collect(
      adapter(fake.baseUrl).streamAttempt(
        request(fake.baseUrl, { input }),
        new AbortController().signal,
      ),
    );

    expect(fake.requests[0]?.body).toMatchObject({ model: "test-model" });
    expect((fake.requests[0]?.body as { messages?: JsonValue }).messages).toEqual([
      { role: "system", name: "safety", content: "Policy" },
      { role: "user", name: "operator", content: "Continue" },
      { role: "assistant", name: "assistant", content: "Calling a Tool" },
      {
        role: "assistant",
        tool_calls: [{
          id: "call_7",
          type: "function",
          function: {
            name: "read_file",
            arguments: '{"path":"a","z":1}',
          },
        }],
      },
      {
        role: "tool",
        tool_call_id: "call_7",
        content: '{"ok":true,"z":false}',
      },
    ]);
  });

  it.each([
    {
      name: "an orphan Tool result",
      input: [{
        type: "tool_result",
        callId: "call_7",
        name: "read_file",
        output: { ok: true },
      }],
    },
    {
      name: "an assistant Tool Call without its following result",
      input: [{
        type: "assistant_tool_call",
        callId: "call_7",
        name: "read_file",
        arguments: { path: "a" },
      }],
    },
    {
      name: "a following result with a different call ID",
      input: [
        {
          type: "assistant_tool_call",
          callId: "call_7",
          name: "read_file",
          arguments: { path: "a" },
        },
        {
          type: "tool_result",
          callId: "call_8",
          name: "read_file",
          output: { ok: true },
        },
      ],
    },
  ] as const)("rejects $name instead of converting it to user text", async ({ input }) => {
    const fake = await startServer(successEvents());
    servers.push(fake.server);

    await expect(
      collect(
        adapter(fake.baseUrl).streamAttempt(
          request(fake.baseUrl, { input }),
          new AbortController().signal,
        ),
      ),
    ).rejects.toMatchObject(protocolErrorMatch);
    expect(fake.requests).toHaveLength(0);
  });

  it.each(["arguments", "result"] as const)(
    "contains non-canonical Tool %s before transport as a protocol error",
    async (field) => {
      const fake = await startServer(successEvents());
      servers.push(fake.server);
      const input: ModelRequest["input"] = [
        {
          type: "assistant_tool_call",
          callId: "call_7",
          name: "read_file",
          arguments: field === "arguments" ? { value: Number.NaN } : { path: "a" },
        },
        {
          type: "tool_result",
          callId: "call_7",
          name: "read_file",
          output: field === "result" ? { value: Number.POSITIVE_INFINITY } : { ok: true },
        },
      ];

      const error = await collect(
        adapter(fake.baseUrl).streamAttempt(
          request(fake.baseUrl, { input }),
          new AbortController().signal,
        ),
      ).catch((cause: unknown) => cause);

      expect(error).toMatchObject(protocolErrorMatch);
      expect(String(error)).toBe("ModelProviderError: model_protocol_error");
      expect(error).not.toHaveProperty("cause");
      expect(fake.requests).toHaveLength(0);
    },
  );

  it("sets streaming and one-call controls while leaving ordinary runs unforced", async () => {
    const fake = await startServer(successEvents());
    servers.push(fake.server);

    await collect(
      adapter(fake.baseUrl).streamAttempt(
        request(fake.baseUrl, { toolChoice: "required" }),
        new AbortController().signal,
      ),
    );

    expect(fake.requests[0]?.body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      parallel_tool_calls: false,
      tools: [expect.objectContaining({
        type: "function",
        function: expect.objectContaining({ name: "read_file" }),
      })],
    });
    expect(fake.requests[0]?.body).not.toHaveProperty("tool_choice");
  });

  it("uses required Tool choice only for a Verification Tool probe", async () => {
    const fake = await startServer(toolCallEvents());
    servers.push(fake.server);

    await collect(
      adapter(fake.baseUrl).streamAttempt(
        request(fake.baseUrl, {
          purpose: "verification_tool",
          toolChoice: "required",
        }),
        new AbortController().signal,
      ),
    );

    expect(fake.requests[0]?.body).toMatchObject({ tool_choice: "required" });
  });

  it.each(["session_summary", "verification_text"] as const)(
    "omits all Tool-only fields for %s",
    async (purpose) => {
      const fake = await startServer(successEvents());
      servers.push(fake.server);

      await collect(
        adapter(fake.baseUrl).streamAttempt(
          request(fake.baseUrl, { purpose, tools: [], toolChoice: "required" }),
          new AbortController().signal,
        ),
      );

      expect(fake.requests[0]?.body).not.toHaveProperty("tools");
      expect(fake.requests[0]?.body).not.toHaveProperty("parallel_tool_calls");
      expect(fake.requests[0]?.body).not.toHaveProperty("tool_choice");
    },
  );

  it("streams text and reports final Usage when present", async () => {
    const fake = await startServer([
      frame({ content: "Hel" }),
      frame({ content: "lo" }),
      frame({}, "stop"),
      usageFrame(11, 3),
    ]);
    servers.push(fake.server);

    const chunks = await collect(
      adapter(fake.baseUrl).streamAttempt(
        request(fake.baseUrl),
        new AbortController().signal,
      ),
    );

    expect(chunks).toEqual([
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      {
        type: "completed",
        finishReason: "completed",
        usage: { inputTokens: 11, outputTokens: 3 },
      },
    ]);
  });

  it("completes without Usage when the provider omits it", async () => {
    const fake = await startServer(successEvents("complete"));
    servers.push(fake.server);

    const chunks = await collect(
      adapter(fake.baseUrl).streamAttempt(
        request(fake.baseUrl),
        new AbortController().signal,
      ),
    );

    expect(chunks.at(-1)).toEqual({
      type: "completed",
      finishReason: "completed",
    });
  });

  it("accepts one valid Usage value attached to the terminal choice", async () => {
    const fake = await startServer([
      choicesFrame(
        [choice(0, { content: "complete" }, "stop")],
        usageValue(7, 2),
      ),
    ]);
    servers.push(fake.server);

    const chunks = await collect(
      adapter(fake.baseUrl).streamAttempt(
        request(fake.baseUrl),
        new AbortController().signal,
      ),
    );

    expect(chunks.at(-1)).toEqual({
      type: "completed",
      finishReason: "completed",
      usage: { inputTokens: 7, outputTokens: 2 },
    });
  });

  it.each([
    {
      name: "an empty zero-choice frame before the terminal",
      events: [choicesFrame([]), ...successEvents()],
    },
    {
      name: "a zero-choice Usage frame before the terminal",
      events: [usageFrame(3, 1), ...successEvents()],
    },
    {
      name: "duplicate zero-choice Usage frames",
      events: [...successEvents(), usageFrame(3, 1), usageFrame(4, 2)],
    },
    {
      name: "an empty zero-choice frame after the terminal",
      events: [...successEvents(), choicesFrame([])],
    },
    {
      name: "Usage attached to a nonterminal choice",
      events: [
        choicesFrame([choice(0, { content: "partial" })], usageValue(3, 1)),
        frame({}, "stop"),
      ],
    },
    {
      name: "zero-choice Usage after terminal-attached Usage",
      events: [
        choicesFrame(
          [choice(0, { content: "complete" }, "stop")],
          usageValue(3, 1),
        ),
        usageFrame(4, 2),
      ],
    },
  ])("rejects $name", async ({ events }) => {
    const fake = await startServer(events);
    servers.push(fake.server);

    const error = await collect(
      adapter(fake.baseUrl).streamAttempt(
        request(fake.baseUrl),
        new AbortController().signal,
      ),
    ).catch((cause: unknown) => cause);

    expect(error).toMatchObject(protocolErrorMatch);
    expect(String(error)).toBe("ModelProviderError: model_protocol_error");
    expect(error).not.toHaveProperty("cause");
  });

  it.each([
    {
      name: "negative input tokens",
      usage: usageValue(-1, 1),
    },
    {
      name: "fractional output tokens",
      usage: usageValue(1, 1.5),
    },
    {
      name: "missing input tokens",
      usage: { completion_tokens: 1, total_tokens: 1 },
    },
    {
      name: "wrong-typed output tokens",
      usage: { prompt_tokens: 1, completion_tokens: "1", total_tokens: 2 },
    },
  ])("rejects Usage with $name", async ({ usage }) => {
    const fake = await startServer([
      ...successEvents(),
      choicesFrame([], usage),
    ]);
    servers.push(fake.server);

    const error = await collect(
      adapter(fake.baseUrl).streamAttempt(
        request(fake.baseUrl),
        new AbortController().signal,
      ),
    ).catch((cause: unknown) => cause);

    expect(error).toMatchObject(protocolErrorMatch);
    expect(String(error)).toBe("ModelProviderError: model_protocol_error");
    expect(error).not.toHaveProperty("cause");
  });

  it("assembles fragmented Tool Call ID, name, and arguments", async () => {
    const fake = await startServer([
      frame({
        tool_calls: [{
          index: 0,
          id: "call_",
          type: "function",
          function: { name: "read_", arguments: '{"pa' },
        }],
      }),
      frame({
        tool_calls: [{
          index: 0,
          id: "8",
          function: { name: "file", arguments: 'th":"b"}' },
        }],
      }),
      frame({}, "tool_calls"),
      usageFrame(20, 5),
    ]);
    servers.push(fake.server);

    const chunks = await collect(
      adapter(fake.baseUrl).streamAttempt(
        request(fake.baseUrl),
        new AbortController().signal,
      ),
    );

    expect(chunks).toContainEqual({
      type: "tool_call",
      callId: "call_8",
      name: "read_file",
      arguments: { path: "b" },
    });
    expect(chunks.filter((chunk) => chunk.type === "tool_call")).toHaveLength(1);
    expect(chunks.filter((chunk) => chunk.type === "completed")).toEqual([{
      type: "completed",
      finishReason: "tool_call",
      usage: { inputTokens: 20, outputTokens: 5 },
    }]);
  });

  it.each([
    ["stop", "completed"],
    ["length", "length"],
    ["content_filter", "content_filter"],
    ["future_provider_reason", "unknown"],
  ] as const)("normalizes %s to %s exactly once", async (providerReason, finishReason) => {
    const fake = await startServer([
      frame({ content: "visible" }),
      frame({}, providerReason),
    ]);
    servers.push(fake.server);

    const chunks = await collect(
      adapter(fake.baseUrl).streamAttempt(
        request(fake.baseUrl),
        new AbortController().signal,
      ),
    );

    expect(chunks.filter((chunk) => chunk.type === "completed")).toEqual([{
      type: "completed",
      finishReason,
    }]);
  });

  it.each([
    {
      name: "a missing terminal reason",
      events: [frame({ content: "incomplete" })],
    },
    {
      name: "multiple choices in one event",
      events: [choicesFrame([
        choice(0, { content: "one" }, "stop"),
        choice(1, { content: "two" }, "stop"),
      ])],
    },
    {
      name: "a nonzero choice index",
      events: [choicesFrame([choice(1, { content: "wrong index" }, "stop")])],
    },
    {
      name: "a duplicate terminal reason",
      events: [
        frame({ content: "complete" }),
        frame({}, "stop"),
        frame({}, "stop"),
      ],
    },
    {
      name: "content after the terminal reason",
      events: [
        frame({ content: "complete" }),
        frame({}, "stop"),
        frame({ content: "late" }),
      ],
    },
    {
      name: "a textless non-call completion",
      events: [frame({}, "stop")],
    },
    {
      name: "a Tool finish without a Tool Call",
      events: [frame({}, "tool_calls")],
    },
    {
      name: "a Tool Call with a non-call finish",
      events: [
        toolDelta({ id: "call_1", name: "read_file", arguments: "{}" }),
        frame({}, "stop"),
      ],
    },
    {
      name: "malformed Tool arguments",
      events: [
        toolDelta({ id: "call_1", name: "read_file", arguments: '{"path":' }),
        frame({}, "tool_calls"),
      ],
    },
    {
      name: "an empty Tool call ID",
      events: [
        toolDelta({ id: "", name: "read_file", arguments: "{}" }),
        frame({}, "tool_calls"),
      ],
    },
    {
      name: "an invalid Tool call ID",
      events: [
        toolDelta({ id: "call 1", name: "read_file", arguments: "{}" }),
        frame({}, "tool_calls"),
      ],
    },
    {
      name: "an empty Tool name",
      events: [
        toolDelta({ id: "call_1", name: "", arguments: "{}" }),
        frame({}, "tool_calls"),
      ],
    },
    {
      name: "empty Tool arguments",
      events: [
        toolDelta({ id: "call_1", name: "read_file", arguments: "" }),
        frame({}, "tool_calls"),
      ],
    },
    {
      name: "multiple Tool Calls",
      events: [choicesFrame([choice(0, {
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "one", arguments: "{}" },
          },
          {
            index: 1,
            id: "call_2",
            type: "function",
            function: { name: "two", arguments: "{}" },
          },
        ],
      })])],
    },
    {
      name: "an inconsistent Tool Call index",
      events: [
        toolDelta({ id: "call_", name: "read_", arguments: "{" }, 0),
        toolDelta({ id: "1", name: "file", arguments: "}" }, 1),
      ],
    },
    {
      name: "an initial nonzero Tool Call index",
      events: [
        toolDelta({ id: "call_1", name: "read_file", arguments: "{}" }, 1),
        frame({}, "tool_calls"),
      ],
    },
    {
      name: "a missing initial Tool Call index",
      events: [
        frame({
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: "{}" },
          }],
        }),
        frame({}, "tool_calls"),
      ],
    },
    {
      name: "a missing Tool Call start type",
      events: [
        frame({
          tool_calls: [{
            index: 0,
            id: "call_1",
            function: { name: "read_file", arguments: "{}" },
          }],
        }),
        frame({}, "tool_calls"),
      ],
    },
    {
      name: "an unsupported Tool Call start type",
      events: [
        frame({
          tool_calls: [{
            index: 0,
            id: "call_1",
            type: "custom",
            function: { name: "read_file", arguments: "{}" },
          }],
        }),
        frame({}, "tool_calls"),
      ],
    },
    {
      name: "a restarted full Tool Call ID and name",
      events: [
        toolDelta({ id: "call_1", name: "read_file", arguments: "{}" }),
        toolDelta({ id: "call_1", name: "read_file", arguments: "" }),
        frame({}, "tool_calls"),
      ],
    },
  ])("rejects $name as a model protocol error", async ({ events }) => {
    const fake = await startServer(events);
    servers.push(fake.server);

    const error = await collect(
      adapter(fake.baseUrl).streamAttempt(
        request(fake.baseUrl),
        new AbortController().signal,
      ),
    ).catch((cause: unknown) => cause);

    expect(error).toMatchObject(protocolErrorMatch);
    expect(String(error)).toBe("ModelProviderError: model_protocol_error");
    expect(error).not.toHaveProperty("cause");
  });

  it("converts an arbitrary pre-abort reason to a generic AbortError", async () => {
    const controller = new AbortController();
    controller.abort(new Error("secret-abort-reason"));

    const error = await collect(
      adapter("http://127.0.0.1:1/v1").streamAttempt(
        request("http://127.0.0.1:1/v1"),
        controller.signal,
      ),
    ).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ name: "AbortError" });
    expect(String(error)).toBe("AbortError: The operation was aborted");
    expect(String(error)).not.toContain("secret-abort-reason");
  });

  it("converts in-flight cancellation to a generic AbortError", async () => {
    const fake = await startServer([frame({ content: "partial" })], { holdOpen: true });
    servers.push(fake.server);
    const controller = new AbortController();
    const pending = collect(
      adapter(fake.baseUrl).streamAttempt(request(fake.baseUrl), controller.signal),
    );
    await fake.requestReceived;
    controller.abort("secret-abort-reason");

    const error = await pending.catch((cause: unknown) => cause);

    expect(error).toMatchObject({ name: "AbortError" });
    expect(String(error)).toBe("AbortError: The operation was aborted");
    expect(String(error)).not.toContain("secret-abort-reason");
  });

  it.each([
    {
      status: 401,
      headers: {},
      expected: { code: "provider_auth_failed", transient: false, status: 401 },
    },
    {
      status: 429,
      headers: { "retry-after": "2" },
      expected: {
        code: "provider_rate_limited",
        transient: true,
        status: 429,
        retryAfterMs: 2_000,
      },
    },
    {
      status: 500,
      headers: { "retry-after": "3" },
      expected: {
        code: "provider_unavailable",
        transient: true,
        status: 500,
        retryAfterMs: 3_000,
      },
    },
  ])("maps safe HTTP $status fields without retry or raw provider leakage", async ({
    status,
    headers,
    expected,
  }) => {
    const fake = await startServer([], {
      status,
      headers,
      body: {
        error: {
          message: "provider-body-secret",
          type: "raw_provider_type",
          code: "raw_provider_code",
        },
      },
    });
    servers.push(fake.server);

    const error = await collect(
      adapter(fake.baseUrl).streamAttempt(
        request(fake.baseUrl),
        new AbortController().signal,
      ),
    ).catch((cause: unknown) => cause);
    const exposed = `${String(error)} ${JSON.stringify(error)}`;

    expect(error).toMatchObject(expected);
    expect(fake.requests).toHaveLength(1);
    expect(error).not.toHaveProperty("cause");
    for (const raw of ["provider-body-secret", "raw_provider_type", "raw_provider_code"]) {
      expect(exposed).not.toContain(raw);
    }
  });

  it("removes the SDK Authorization header and never resolves a Secret in none mode", async () => {
    const fake = await startServer(successEvents());
    servers.push(fake.server);
    const auth = { type: "none" } as const;
    const transport = new NodeProviderHttpTransport({
      secretResolver: {
        resolve() {
          throw new Error("none mode must not resolve a Secret");
        },
      },
    });

    await collect(
      adapter(fake.baseUrl, { auth, transport }).streamAttempt(
        request(fake.baseUrl, { auth }),
        new AbortController().signal,
      ),
    );

    expect(fake.requests[0]?.authorization).toBeUndefined();
  });

  it("contains an SDK-wrapped transport failure without raw error leakage", async () => {
    const baseUrl = "http://127.0.0.1:1/v1";
    const transport: ProviderHttpTransport = {
      createFetch() {
        return (async () => {
          throw new Error("raw-sdk-transport-secret");
        }) as typeof fetch;
      },
    };

    const error = await collect(
      adapter(baseUrl, { transport }).streamAttempt(
        request(baseUrl),
        new AbortController().signal,
      ),
    ).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "provider_unavailable",
      transient: true,
    });
    expect(String(error)).toBe("ModelProviderError: provider_unavailable");
    expect(JSON.stringify(error)).not.toContain("raw-sdk-transport-secret");
    expect(error).not.toHaveProperty("cause");
  });

  it("rejects a non-Chat snapshot before transport", async () => {
    const baseUrl = "http://127.0.0.1:1/v1";
    const canonical = request(baseUrl);

    await expect(collect(adapter(baseUrl).streamAttempt({
      ...canonical,
      model: { ...canonical.model, invocationProtocol: "responses" },
    }, new AbortController().signal))).rejects.toMatchObject({
      code: "invocation_protocol_unsupported",
      transient: false,
    });
  });

  it("accepts Chat when the exact stored Connection prefers Responses", async () => {
    const fake = await startServer(successEvents());
    servers.push(fake.server);

    const chunks = await collect(
      adapter(fake.baseUrl, { protocolPreference: "responses" }).streamAttempt(
        request(fake.baseUrl),
        new AbortController().signal,
      ),
    );

    expect(chunks.at(-1)).toEqual({
      type: "completed",
      finishReason: "completed",
    });
    expect(fake.requests).toHaveLength(1);
  });

  it.each([
    {
      name: "revision ID",
      mutate: (canonical: ModelRequest): ModelRequest => ({
        ...canonical,
        model: {
          ...canonical.model,
          providerConnectionRevisionId: providerConnectionRevisionIdFromUuid(
            "00000000-0000-7000-8000-000000000399",
          ),
        },
      }),
    },
    {
      name: "base URL",
      mutate: (canonical: ModelRequest): ModelRequest => ({
        ...canonical,
        model: { ...canonical.model, baseUrl: "http://127.0.0.1:2/v1" },
      }),
    },
    {
      name: "auth",
      mutate: (canonical: ModelRequest): ModelRequest => ({
        ...canonical,
        model: { ...canonical.model, providerAuth: { type: "none" } },
      }),
    },
    {
      name: "compatibility preset",
      mutate: (canonical: ModelRequest): ModelRequest => ({
        ...canonical,
        model: { ...canonical.model, compatibilityPresetVersion: "other-v1" },
      }),
    },
  ])("rejects a snapshot with inconsistent exact Connection $name", async ({ mutate }) => {
    const baseUrl = "http://127.0.0.1:1/v1";

    await expect(collect(adapter(baseUrl).streamAttempt(
      mutate(request(baseUrl)),
      new AbortController().signal,
    ))).rejects.toMatchObject(protocolErrorMatch);
  });
});

const protocolErrorMatch = {
  code: "model_protocol_error",
  transient: false,
};

interface AdapterOptions {
  readonly protocolPreference?: "chat_completions" | "responses";
  readonly auth?: ProviderAuth;
  readonly transport?: ProviderHttpTransport;
}

function adapter(
  storedBaseUrl: string,
  options: AdapterOptions = {},
): OpenAiChatCompletionsModel {
  const revisionId = providerConnectionRevisionIdFromUuid(
    "00000000-0000-7000-8000-000000000301",
  );
  const auth = options.auth ?? {
    type: "bearer",
    secret: { fromEnvironment: "TEST_API_KEY" },
  };
  return new OpenAiChatCompletionsModel({
    transport: options.transport ?? new NodeProviderHttpTransport({
      secretResolver: new EnvironmentSecretResolver({ TEST_API_KEY: "test-key" }),
    }),
    connections: {
      getConnectionRevision(requestedRevisionId) {
        if (requestedRevisionId !== revisionId) return null;
        return {
          providerKind: "openai_compatible",
          revision: {
            revisionId,
            connectionId: parseProviderConnectionId("openai-test"),
            state: "active",
            baseUrl: storedBaseUrl,
            auth,
            allowInsecureHttp: true,
            protocolPreference: options.protocolPreference ?? "chat_completions",
            presetVersion: "openai-chat-v1",
            createdAt: new Date("2026-08-09T00:00:00.000Z"),
          },
        };
      },
    },
  });
}

interface RequestOptions {
  readonly purpose?: ModelRequest["purpose"];
  readonly input?: ModelRequest["input"];
  readonly tools?: ModelRequest["tools"];
  readonly toolChoice?: ModelRequest["toolChoice"];
  readonly auth?: ProviderAuth;
}

function request(baseUrl: string, options: RequestOptions = {}): ModelRequest {
  return {
    purpose: options.purpose ?? "run",
    model: {
      providerConnectionRevisionId: providerConnectionRevisionIdFromUuid(
        "00000000-0000-7000-8000-000000000301",
      ),
      providerKind: "openai_compatible",
      baseUrl,
      providerAuth: options.auth ?? {
        type: "bearer",
        secret: { fromEnvironment: "TEST_API_KEY" },
      },
      modelId: "test-model",
      invocationProtocol: "chat_completions",
      maxInputTokens: 8_192,
      verifiedCapabilities: ["streaming_text", "single_tool_call"],
      compatibilityPresetVersion: "openai-chat-v1",
    },
    input: options.input ?? [
      { type: "message", role: "system", name: "runtime_safety", content: "Follow policy." },
      { type: "message", role: "user", name: "operator", content: "Read the report." },
    ],
    tools: options.tools ?? [
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
    ...(options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice }),
  };
}

interface FakeServerOptions {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: JsonValue;
  readonly holdOpen?: boolean;
}

interface CapturedRequest {
  readonly body: JsonValue;
  readonly authorization?: string;
  readonly path?: string;
}

async function startServer(
  events: readonly JsonValue[],
  options: FakeServerOptions = {},
): Promise<{
  server: Server;
  baseUrl: string;
  requests: CapturedRequest[];
  requestReceived: Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  let markRequestReceived: (() => void) | undefined;
  const requestReceived = new Promise<void>((resolve) => {
    markRequestReceived = resolve;
  });
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      requests.push({
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonValue,
        ...(incoming.headers.authorization === undefined
          ? {}
          : { authorization: incoming.headers.authorization }),
        ...(incoming.url === undefined ? {} : { path: incoming.url }),
      });
      markRequestReceived?.();
      if (options.status !== undefined) {
        response.writeHead(options.status, {
          "content-type": "application/json",
          ...options.headers,
        });
        response.end(JSON.stringify(options.body ?? {}));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events) {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      if (!options.holdOpen) {
        response.end("data: [DONE]\n\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    requestReceived,
  };
}

function successEvents(text = "ok"): JsonValue[] {
  return [frame({ content: text }), frame({}, "stop")];
}

function toolCallEvents(): JsonValue[] {
  return [
    toolDelta({ id: "call_1", name: "read_file", arguments: "{}" }),
    frame({}, "tool_calls"),
  ];
}

function choice(index: number, delta: JsonValue, finishReason: string | null = null): JsonValue {
  return { index, delta, finish_reason: finishReason };
}

function choicesFrame(
  choices: readonly JsonValue[],
  usage: JsonValue | null = null,
): JsonValue {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices: [...choices],
    usage,
  };
}

function frame(delta: JsonValue, finishReason: string | null = null): JsonValue {
  return choicesFrame([choice(0, delta, finishReason)]);
}

function toolDelta(
  fragments: { readonly id: string; readonly name: string; readonly arguments: string },
  index = 0,
): JsonValue {
  return frame({
    tool_calls: [{
      index,
      id: fragments.id,
      type: "function",
      function: { name: fragments.name, arguments: fragments.arguments },
    }],
  });
}

function usageFrame(inputTokens: number, outputTokens: number): JsonValue {
  return choicesFrame([], usageValue(inputTokens, outputTokens));
}

function usageValue(inputTokens: number, outputTokens: number): JsonValue {
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  };
}

async function collect(stream: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}
