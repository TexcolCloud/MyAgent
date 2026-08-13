import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import type { JsonValue } from "../../src/domain/json.js";

export interface FakeModelsPage {
  readonly data: readonly unknown[];
  readonly has_more?: boolean;
  readonly last_id?: string;
}

export interface FakeModelsFailure {
  readonly status: number;
  readonly body?: unknown;
  readonly delayMs?: number;
}

export type FakeProviderTurn =
  | {
      readonly type: "text";
      readonly text: string;
      readonly reasoning?: string;
      readonly rawBody?: string;
      readonly delayMs?: number;
    }
  | { readonly type: "verification_text"; readonly text: string; readonly delayMs?: number }
  | { readonly type: "verification_tool"; readonly callId: string; readonly delayMs?: number }
  | {
      readonly type: "tool";
      readonly callId: string;
      readonly name: string;
      readonly arguments: JsonValue;
      readonly delayMs?: number;
    }
  | {
      readonly type: "multi_tool";
      readonly calls: readonly [
        { readonly callId: string; readonly name: string; readonly arguments: JsonValue },
        { readonly callId: string; readonly name: string; readonly arguments: JsonValue },
      ];
      readonly rawBody?: string;
      readonly delayMs?: number;
    }
  | {
      readonly type: "error";
      readonly status: number;
      readonly body?: JsonValue;
      readonly delayMs?: number;
    };

export interface CapturedProviderRequest {
  readonly method: string;
  readonly path: string;
  readonly body: JsonValue;
  readonly credentialMatched: boolean;
}

export interface FakeOpenAiProviderOptions {
  readonly models?: readonly string[];
  readonly chat?: readonly FakeProviderTurn[];
  readonly responses?: readonly FakeProviderTurn[];
  readonly responsesRedirectUrl?: string;
  readonly expectedApiKey?: string;
}

export class FakeOpenAiProvider {
  readonly requests: Array<{ path: string; after?: string }> = [];
  readonly chatRequests: CapturedProviderRequest[] = [];
  readonly responsesRequests: CapturedProviderRequest[] = [];
  readonly rawResponseBodies: string[] = [];
  private readonly pages = new Map<string | undefined, FakeModelsPage>();
  private readonly chatTurns: FakeProviderTurn[];
  private readonly responsesTurns: FakeProviderTurn[];
  private readonly responsesRedirectUrl: string | undefined;
  private readonly expectedApiKey: string | undefined;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly sockets = new Set<Socket>();
  private failure: FakeModelsFailure | undefined;
  private delayMs = 0;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  private constructor(
    private readonly server: Server,
    options: FakeOpenAiProviderOptions,
  ) {
    this.chatTurns = [...(options.chat ?? [])];
    this.responsesTurns = [...(options.responses ?? [])];
    this.responsesRedirectUrl = options.responsesRedirectUrl;
    this.expectedApiKey = options.expectedApiKey;
    this.modelsPages([{
      data: (options.models ?? []).map((id) => ({ id, object: "model", owned_by: "fake" })),
      has_more: false,
    }]);
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
  }

  static async start(
    options: FakeOpenAiProviderOptions = {},
  ): Promise<FakeOpenAiProvider> {
    const server = createServer((request, response) => {
      void provider.handle(request, response);
    });
    const provider = new FakeOpenAiProvider(server, options);
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });
    return provider;
  }

  get baseUrl(): string {
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${String(address.port)}/v1`;
  }

  modelsPages(pages: readonly FakeModelsPage[]): void {
    this.pages.clear();
    for (const [index, page] of pages.entries()) {
      const previous = pages[index - 1];
      this.pages.set(index === 0 ? undefined : previous?.last_id, page);
    }
    this.failure = undefined;
  }

  modelsFailure(failure: FakeModelsFailure): void {
    this.failure = failure;
  }

  delayResponses(milliseconds: number): void {
    this.delayMs = milliseconds;
  }

  clearCapturedRequests(): void {
    this.requests.length = 0;
    this.chatRequests.length = 0;
    this.responsesRequests.length = 0;
    this.rawResponseBodies.length = 0;
  }

  replaceChatTurns(turns: readonly FakeProviderTurn[]): void {
    this.chatTurns.splice(0, this.chatTurns.length, ...turns);
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.closePromise = new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    return this.closePromise;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://provider.test");
    if (request.method === "GET" && url.pathname === "/v1/models") {
      this.handleModels(url, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = await readJsonBody(request);
      this.chatRequests.push(this.captureRequest(request, url.pathname, body));
      this.respondToTurn("chat", body, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/responses") {
      const body = await readJsonBody(request);
      this.responsesRequests.push(this.captureRequest(request, url.pathname, body));
      if (this.responsesRedirectUrl !== undefined) {
        response.writeHead(307, { location: this.responsesRedirectUrl }).end();
        return;
      }
      this.respondToTurn("responses", body, response);
      return;
    }
    response.writeHead(404).end();
  }

  private handleModels(url: URL, response: ServerResponse): void {
    const after = url.searchParams.get("after") ?? undefined;
    this.requests.push({ path: url.pathname, ...(after === undefined ? {} : { after }) });
    const failure = this.failure;
    const delay = failure?.delayMs ?? this.delayMs;
    this.schedule(delay, () => {
      if (failure !== undefined) {
        response.writeHead(failure.status, { "content-type": "application/json" });
        response.end(JSON.stringify(failure.body ?? { error: { message: "provider-secret" } }));
        return;
      }
      const page = this.pages.get(after) ?? { data: [] };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", ...page }));
    });
  }

  private respondToTurn(
    protocol: "chat" | "responses",
    body: JsonValue,
    response: ServerResponse,
  ): void {
    const turns = protocol === "chat" ? this.chatTurns : this.responsesTurns;
    const turn = turns.shift();
    if (turn === undefined) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "fake_provider_turn_missing" } }));
      return;
    }
    this.schedule(turn.delayMs ?? 0, () => {
      if (turn.type === "error") {
        response.writeHead(turn.status, { "content-type": "application/json" });
        const payload = JSON.stringify(turn.body ?? { error: { code: "fake_provider_error" } });
        this.rawResponseBodies.push(payload);
        response.end(payload);
        return;
      }
      const normalized = turn.type === "verification_tool"
        ? {
            type: "tool" as const,
            callId: turn.callId,
            name: "capability_probe",
            arguments: { nonce: verificationNonce(body) },
          }
        : turn;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const events = protocol === "chat"
        ? chatEvents(normalized)
        : responsesEvents(normalized);
      const payload = [
        ...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
        "data: [DONE]\n\n",
      ].join("");
      this.rawResponseBodies.push(payload);
      response.end(payload);
    });
  }

  private captureRequest(
    request: IncomingMessage,
    path: string,
    body: JsonValue,
  ): CapturedProviderRequest {
    const authorization = request.headers.authorization;
    return {
      method: request.method ?? "",
      path,
      body,
      credentialMatched: this.expectedApiKey === undefined
        ? authorization === undefined
        : authorization === `Bearer ${this.expectedApiKey}`,
    };
  }

  private schedule(delayMs: number, action: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed) action();
    }, delayMs);
    timer.unref?.();
    this.timers.add(timer);
  }
}

function chatEvents(
  turn: Exclude<FakeProviderTurn, { type: "error" | "verification_tool" }>,
): JsonValue[] {
  if (turn.type === "text" || turn.type === "verification_text") {
    const rawFields = turn.type === "text"
      ? {
          ...(turn.reasoning === undefined
            ? {}
            : { reasoning_content: turn.reasoning }),
          ...(turn.rawBody === undefined
            ? {}
            : { raw_provider_body: turn.rawBody }),
        }
      : {};
    return [
      { ...chatFrame({ content: turn.text, ...rawFields }), ...rawFields },
      chatFrame({}, "stop"),
      chatUsageFrame(),
    ];
  }
  const calls = turn.type === "multi_tool" ? turn.calls : [turn];
  return [
    chatFrame({
      tool_calls: calls.map((call, index) => ({
        index,
        id: call.callId,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    }),
    chatFrame({}, "tool_calls"),
    chatUsageFrame(),
  ];
}

function responsesEvents(
  turn: Exclude<FakeProviderTurn, { type: "error" | "verification_tool" }>,
): JsonValue[] {
  if (turn.type === "text" || turn.type === "verification_text") {
    const rawEvents: JsonValue[] = turn.type === "text" &&
      (turn.reasoning !== undefined || turn.rawBody !== undefined)
      ? [{
          type: "response.reasoning_summary_text.delta",
          delta: turn.reasoning ?? "",
          ...(turn.rawBody === undefined
            ? {}
            : { raw_provider_body: turn.rawBody }),
        }]
      : [];
    const item = {
      id: "msg_fake",
      type: "message" as const,
      role: "assistant" as const,
      status: "completed" as const,
      content: [{ type: "output_text" as const, text: turn.text, annotations: [] }],
    };
    return [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      },
      {
        type: "response.content_part.added",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      ...rawEvents,
      { type: "response.output_text.delta", delta: turn.text },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: completedResponse([item]),
      },
    ];
  }
  const calls = turn.type === "multi_tool" ? turn.calls : [turn];
  const items = calls.map((call) => ({
    id: `fc_${call.callId}`,
    type: "function_call",
    call_id: call.callId,
    name: call.name,
    arguments: JSON.stringify(call.arguments),
    status: "completed",
    ...(turn.type !== "multi_tool" || turn.rawBody === undefined
      ? {}
      : { raw_provider_body: turn.rawBody }),
  }));
  return [
    ...items.flatMap((item, outputIndex) => [{
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { ...item, arguments: "", status: "in_progress" },
    }, {
      type: "response.function_call_arguments.delta",
      output_index: outputIndex,
      item_id: item.id,
      delta: item.arguments,
    }, {
      type: "response.function_call_arguments.done",
      output_index: outputIndex,
      item_id: item.id,
      arguments: item.arguments,
    }, { type: "response.output_item.done", output_index: outputIndex, item }]),
    { type: "response.completed", response: completedResponse(items) },
  ];
}

function completedResponse(output: JsonValue[]): JsonValue {
  return {
    id: "resp_fake",
    object: "response",
    created_at: 0,
    model: "fake-model",
    status: "completed",
    output,
    usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
  };
}

function chatFrame(
  delta: JsonValue,
  finishReason: string | null = null,
): Record<string, JsonValue> {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    usage: null,
  };
}

function chatUsageFrame(): JsonValue {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake-model",
    choices: [],
    usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
  };
}

function verificationNonce(body: JsonValue): string {
  const serialized = JSON.stringify(body);
  const match = /nonce ([0-9a-f]{8}-[0-9a-f-]{27})/i.exec(serialized);
  if (match?.[1] === undefined) throw new Error("fake_verification_nonce_missing");
  return match[1];
}

async function readJsonBody(request: IncomingMessage): Promise<JsonValue> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonValue;
}
