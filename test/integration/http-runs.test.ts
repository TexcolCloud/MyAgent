import { describe, expect, it } from "vitest";

import { startTestApp } from "../helpers/start-test-app.js";

const auth = { authorization: "Bearer test-token", "idempotency-key": "request-0001" };

describe("HTTP Runs", () => {
  it("creates a queued Run and returns its durable resource", async () => {
    const harness = await startTestApp();
    try {
      const created = await harness.app.inject({
        method: "POST", url: "/v1/runs", headers: auth,
        payload: { agentId: "primary", sessionKey: "session:a", input: { type: "text", text: "hello" } },
      });
      expect(created.statusCode).toBe(202);
      expect(created.json()).toMatchObject({ runId: expect.stringMatching(/^run_/), status: "queued", eventsUrl: expect.stringMatching(/^\/v1\/runs\/run_/) });

      const run = await harness.app.inject({ method: "GET", url: `/v1/runs/${created.json().runId}`, headers: auth });
      expect(run.statusCode).toBe(200);
      expect(run.json()).toMatchObject({ runId: created.json().runId, status: "queued", agentId: "primary" });
    } finally { await harness.close(); }
  });
});
