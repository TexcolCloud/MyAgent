import { describe, expect, it, vi } from "vitest";

import { CliClient } from "../../src/interfaces/cli/client.js";
import {
  consumeRunEvents,
  RunEventStreamError,
  type SafeRunEvent,
} from "../../src/interfaces/tui/run-event-stream.js";
import { ChatScreen } from "../../src/interfaces/tui/screens/chat.js";
import { TuiClient } from "../../src/interfaces/tui/tui-client.js";

describe("consumeRunEvents", () => {
  it("creates one Run and resumes its committed stream after interruption", async () => {
    const createRunBodies: unknown[] = [];
    const idempotencyKeys: (string | null)[] = [];
    const lastEventIds: (string | null)[] = [];
    let streamAttempt = 0;
    const client = new TuiClient({
      runToken: "run-token",
      adminToken: "admin-token",
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/runs") {
          createRunBodies.push(JSON.parse(String(init?.body)) as unknown);
          idempotencyKeys.push(new Headers(init?.headers).get("idempotency-key"));
          return Response.json({
            runId: "run_1",
            status: "queued",
            eventsUrl: "/v1/runs/run_1/events",
          }, { status: 202 });
        }
        lastEventIds.push(new Headers(init?.headers).get("last-event-id"));
        streamAttempt += 1;
        return streamAttempt === 1
          ? interruptedSseResponse(eventFrame(4, "message.delta", { text: "safe status" }))
          : sseResponse([eventFrame(5, "run.completed", { result: { type: "text", text: "done" } })]);
      },
    });
    const chat = new ChatScreen({ client });

    await chat.submit({ agentId: "primary", sessionKey: "tui:main", text: "read status" });
    expect(createRunBodies).toEqual([{
      agentId: "primary",
      sessionKey: "tui:main",
      input: { type: "text", text: "read status" },
    }]);
    expect(idempotencyKeys[0]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(chat.render(100).join("\n")).toContain("Reconnect available");

    await chat.reconnect();

    expect(createRunBodies).toHaveLength(1);
    expect(lastEventIds).toEqual([null, "4"]);
    expect(chat.render(100).join("\n")).toContain("run.completed");
  });

  it("reconnects from the committed cursor after a malformed SSE frame", async () => {
    const createRunBodies: unknown[] = [];
    const lastEventIds: (string | null)[] = [];
    const rawMalformedData = "raw-provider-secret";
    let streamAttempt = 0;
    const client = new TuiClient({
      runToken: "run-token",
      adminToken: "admin-token",
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/runs") {
          createRunBodies.push(JSON.parse(String(init?.body)) as unknown);
          return Response.json({
            runId: "run_1",
            status: "queued",
            eventsUrl: "/v1/runs/run_1/events",
          }, { status: 202 });
        }
        lastEventIds.push(new Headers(init?.headers).get("last-event-id"));
        streamAttempt += 1;
        return streamAttempt === 1
          ? sseResponse([
            eventFrame(4, "message.delta", { text: "safe status" }),
            `id: 5\nevent: message.delta\ndata: ${rawMalformedData}\n\n`,
          ])
          : sseResponse([eventFrame(5, "run.completed", { result: { type: "text", text: "done" } })]);
      },
    });
    const chat = new ChatScreen({ client });

    await chat.submit({ agentId: "primary", sessionKey: "tui:main", text: "read status" });
    const afterFailure = chat.render(100).join("\n");
    expect(afterFailure).toContain("4 message.delta");
    expect(afterFailure).not.toContain(rawMalformedData);

    await chat.reconnect();

    expect(createRunBodies).toHaveLength(1);
    expect(lastEventIds).toEqual([null, "4"]);
    expect(chat.render(100).filter((line) => line === "4 message.delta")).toHaveLength(1);
  });

  it("parses comments and frames split across chunks, then reconnects from the greatest committed ID", async () => {
    const lastEventIds: (string | null)[] = [];
    const responses = [
      sseResponse([
        ": heart",
        "beat\r\n\r\nid: 12\r\nevent: message.delta\r\ndata: {\"runId\":\"run_1\",\"sequence\":12,",
        "\"type\":\"message.delta\",\"occurredAt\":\"2026-08-12T00:00:00.000Z\",\"payload\":{\"text\":\"hello\"}}\r\n\r\n",
        "id: 9\nevent: message.completed\ndata: {\"runId\":\"run_1\",\"sequence\":9,\"type\":\"message.completed\",\"occurredAt\":\"2026-08-12T00:00:01.000Z\",\"payload\":{\"text\":\"old\"}}\n\n",
      ]),
      sseResponse([]),
    ];
    const client = cliClient(async (_input, init) => {
      lastEventIds.push(new Headers(init?.headers).get("last-event-id"));
      return responses.shift()!;
    });
    const events: SafeRunEvent[] = [];
    const signal = new AbortController().signal;

    const cursor = await consumeRunEvents({
      client,
      cursor: { runId: "run_1" },
      onEvent: (event) => { events.push(event); },
      signal,
    });
    expect(cursor).toEqual({ runId: "run_1", lastEventId: "12" });
    expect(events.map((event) => event.sequence)).toEqual([12, 9]);

    await consumeRunEvents({ client, cursor, onEvent: () => undefined, signal });
    expect(lastEventIds).toEqual([null, "12"]);
  });

  it.each(["run.completed", "run.failed", "run.cancelled"] as const)(
    "stops after the %s terminal event",
    async (terminalType) => {
      const trailing = eventFrame(3, "message.delta", { text: "must not render" });
      const client = cliClient(async () => sseResponse([
        eventFrame(2, terminalType, terminalType === "run.completed" ? { result: { type: "text", text: "done" } } : {}),
        trailing,
      ]));
      const events: SafeRunEvent[] = [];

      const cursor = await consumeRunEvents({
        client,
        cursor: { runId: "run_1" },
        onEvent: (event) => { events.push(event); },
        signal: new AbortController().signal,
      });

      expect(events.map((event) => event.type)).toEqual([terminalType]);
      expect(cursor).toEqual({ runId: "run_1", lastEventId: "2" });
    },
  );

  it("rejects malformed event data without exposing raw text or advancing its recoverable cursor", async () => {
    const secret = "raw-provider-secret";
    const client = cliClient(async () => sseResponse([
      eventFrame(4, "message.delta", { text: "safe" }),
      `id: 5\nevent: message.delta\ndata: ${secret}\n\n`,
    ]));
    const onEvent = vi.fn();

    const failure = await consumeRunEvents({
      client,
      cursor: { runId: "run_1", lastEventId: "3" },
      onEvent,
      signal: new AbortController().signal,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RunEventStreamError);
    expect(failure).toMatchObject({
      code: "invalid_run_event",
      detail: "The committed Run event is invalid.",
      cursor: { runId: "run_1", lastEventId: "4" },
    });
    expect(String(failure)).not.toContain(secret);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("does not commit an event until the callback accepts the safe decoded value", async () => {
    const client = cliClient(async () => sseResponse([eventFrame(8, "message.completed", { text: "safe" })]));

    const failure = await consumeRunEvents({
      client,
      cursor: { runId: "run_1", lastEventId: "7" },
      onEvent: () => { throw new Error("renderer_failed"); },
      signal: new AbortController().signal,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ message: "renderer_failed" });
  });

  it("returns the last committed cursor on network interruption", async () => {
    const client = cliClient(async () => interruptedSseResponse(eventFrame(6, "message.delta", { text: "safe" })));
    const events: SafeRunEvent[] = [];

    await expect(consumeRunEvents({
      client,
      cursor: { runId: "run_1", lastEventId: "5" },
      onEvent: (event) => { events.push(event); },
      signal: new AbortController().signal,
      interruption: "return_cursor",
    })).resolves.toEqual({ runId: "run_1", lastEventId: "6" });
    expect(events).toHaveLength(1);
  });

  it("propagates a missing Run credential instead of treating it as a reconnectable interruption", async () => {
    const client = new CliClient({ baseUrl: "http://127.0.0.1:8787" });

    for (const interruption of [undefined, "return_cursor"] as const) {
      await expect(consumeRunEvents({
        client,
        cursor: { runId: "run_1" },
        onEvent: () => undefined,
        signal: new AbortController().signal,
        ...(interruption === undefined ? {} : { interruption }),
      })).rejects.toMatchObject({ code: "run_token_required" });
    }
  });

  it("propagates fetch rejection unless cursor recovery is explicitly requested", async () => {
    const failure = new TypeError("network unavailable");
    const client = cliClient(async () => { throw failure; });

    await expect(consumeRunEvents({
      client,
      cursor: { runId: "run_1", lastEventId: "4" },
      onEvent: () => undefined,
      signal: new AbortController().signal,
    })).rejects.toBe(failure);
    await expect(consumeRunEvents({
      client,
      cursor: { runId: "run_1", lastEventId: "4" },
      onEvent: () => undefined,
      signal: new AbortController().signal,
      interruption: "return_cursor",
    })).resolves.toEqual({ runId: "run_1", lastEventId: "4" });
  });

  it("forwards abort to fetch and stops a pending read at the last committed cursor", async () => {
    const controller = new AbortController();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(readController) { streamController = readController; },
      });
      init?.signal?.addEventListener("abort", () => {
        streamController?.error(new DOMException("aborted", "AbortError"));
      }, { once: true });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    });
    const client = cliClient(fetcher);

    const consuming = consumeRunEvents({
      client,
      cursor: { runId: "run_1", lastEventId: "2" },
      onEvent: () => undefined,
      signal: controller.signal,
    });
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledOnce(); });
    controller.abort();

    await expect(consuming).resolves.toEqual({ runId: "run_1", lastEventId: "2" });
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});

function cliClient(fetcher: typeof fetch): CliClient {
  return new CliClient({ baseUrl: "http://127.0.0.1:8787", bearerToken: "run", fetcher });
}

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

function interruptedSseResponse(frame: string): Response {
  const encoder = new TextEncoder();
  let reads = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads++ === 0) {
        controller.enqueue(encoder.encode(frame));
        return;
      }
      controller.error(new TypeError("network socket closed"));
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

function eventFrame(sequence: number, type: string, payload: unknown): string {
  return `id: ${String(sequence)}\nevent: ${type}\ndata: ${JSON.stringify({
    runId: "run_1",
    sequence,
    type,
    occurredAt: "2026-08-12T00:00:00.000Z",
    payload,
  })}\n\n`;
}
