import { describe, expect, it } from "vitest";

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
});
