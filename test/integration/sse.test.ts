import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { RunId } from "../../src/domain/ids.js";
import { streamRunEvents } from "../../src/interfaces/http/sse.js";
import type { FaultPoint } from "../../src/runtime/fault-injector.js";
import { startTestApp } from "../helpers/start-test-app.js";

describe("SSE", () => {
  it("replays strictly after Last-Event-ID from persisted events", async () => {
    const harness = await startTestApp();
    try {
      const created = await harness.app.inject({ method: "POST", url: "/v1/runs", headers: { authorization: "Bearer test-token", "idempotency-key": "request-0001" }, payload: { agentId: "primary", sessionKey: "session:a", input: { type: "text", text: "hello" } } });
      const runId = created.json().runId;
      harness.runs.appendEvent(runId, "message.delta", { text: "second" }, new Date("2026-08-07T00:00:01.000Z"));
      harness.runs.appendEvent(runId, "message.completed", { text: "third" }, new Date("2026-08-07T00:00:02.000Z"));
      harness.runs.cancel({ runId, occurredAt: new Date("2026-08-07T00:00:03.000Z") });
      const stream = await harness.app.inject({ method: "GET", url: `/v1/runs/${runId}/events`, headers: { authorization: "Bearer test-token", "last-event-id": "1" } });
      expect(stream.statusCode).toBe(200);
      expect(stream.payload).toContain("id: 2");
      expect(stream.payload).toContain("id: 3");
      expect(stream.payload).not.toContain("id: 1\n");
    } finally { await harness.close(); }
  });

  it("rejects an invalid Last-Event-ID before hijacking the response", async () => {
    const harness = await startTestApp();
    try {
      const created = await harness.app.inject({ method: "POST", url: "/v1/runs", headers: { authorization: "Bearer test-token", "idempotency-key": "request-0002" }, payload: { agentId: "primary", sessionKey: "session:invalid-cursor", input: { type: "text", text: "hello" } } });
      const response = await harness.app.inject({ method: "GET", url: `/v1/runs/${created.json().runId}/events`, headers: { authorization: "Bearer test-token", "last-event-id": "01" } });
      expect(response.statusCode).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json()).toMatchObject({ code: "invalid_request" });
    } finally {
      await harness.close();
    }
  });

  it("emits a heartbeat at 15 seconds and stops polling on disconnect", async () => {
    vi.useFakeTimers();
    const response = new FakeResponse();
    const faultPoints: FaultPoint[] = [];
    const runs = {
      getRun: () => ({ state: "running" }),
      listEventsAfter: vi.fn(() => []),
    };
    const streaming = streamRunEvents(
      { headers: {} } as never,
      response as never,
      "run_sse_heartbeat" as RunId,
      runs as never,
      { faults: { hit: async (point) => { faultPoints.push(point); } } },
    );
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(response.writes).toContain(": heartbeat\n\n");
      expect(faultPoints).toEqual([]);
      const callsAtDisconnect = runs.listEventsAfter.mock.calls.length;
      response.emit("close");
      await vi.advanceTimersByTimeAsync(200);
      await streaming;
      expect(runs.listEventsAfter).toHaveBeenCalledTimes(callsAtDisconnect);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wraps each persisted event write with fault boundaries", async () => {
    const response = new FakeResponse();
    const faultPoints: FaultPoint[] = [];
    const runs = {
      getRun: () => ({ state: "completed" }),
      listEventsAfter: () => [{
        runId: "run_sse_persisted",
        sequence: 1,
        type: "run.completed",
        occurredAt: new Date("2026-08-07T00:00:00.000Z"),
        payload: { result: "done" },
      }],
    };

    await streamRunEvents(
      { headers: {} } as never,
      response as never,
      "run_sse_persisted" as RunId,
      runs as never,
      { faults: { hit: async (point) => { faultPoints.push(point); } } },
    );

    expect(faultPoints).toEqual(["before_sse_write", "after_sse_write"]);
    expect(response.writes).toHaveLength(1);
    expect(response.writes[0]).toContain("event: run.completed");
  });

  it("does not hang when a backpressured client disconnects before drain", async () => {
    const response = new FakeResponse(false);
    const runs = {
      getRun: () => ({ state: "completed" }),
      listEventsAfter: () => [{
        runId: "run_sse_backpressure",
        sequence: 1,
        type: "run.completed",
        occurredAt: new Date("2026-08-07T00:00:00.000Z"),
        payload: { result: "done" },
      }],
    };
    const streaming = streamRunEvents(
      { headers: {} } as never,
      response as never,
      "run_sse_backpressure" as RunId,
      runs as never,
    );
    response.emit("close");
    await expect(Promise.race([
      streaming.then(() => "closed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ])).resolves.toBe("closed");
    expect(response.writableEnded).toBe(false);
  });
});

class FakeResponse extends EventEmitter {
  writableEnded = false;
  readonly writes: string[] = [];

  constructor(private readonly writable = true) { super(); }

  write(value: string): boolean {
    this.writes.push(value);
    return this.writable;
  }

  end(): void {
    this.writableEnded = true;
  }
}
