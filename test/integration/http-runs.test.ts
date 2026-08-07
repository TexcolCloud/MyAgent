import { describe, expect, it } from "vitest";

import type { CancelRunService } from "../../src/application/cancel-run.js";
import type { CreateRunService } from "../../src/application/create-run.js";
import { createHttpApp } from "../../src/interfaces/http/app.js";
import type { RunStore } from "../../src/ports/run-store.js";
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

  it("makes duplicate creation idempotent and rejects a conflicting payload", async () => {
    const harness = await startTestApp();
    try {
      const request = {
        method: "POST" as const,
        url: "/v1/runs",
        headers: auth,
        payload: { agentId: "primary", sessionKey: "session:idempotent", input: { type: "text", text: "hello" } },
      };
      const first = await harness.app.inject(request);
      const duplicate = await harness.app.inject(request);
      expect(duplicate.statusCode).toBe(202);
      expect(duplicate.json().runId).toBe(first.json().runId);

      const conflict = await harness.app.inject({
        ...request,
        payload: { ...request.payload, input: { type: "text", text: "different" } },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ code: "idempotency_conflict" });
    } finally {
      await harness.close();
    }
  });

  it("returns 422 for an unavailable Agent and supports cancellation", async () => {
    const harness = await startTestApp();
    try {
      const unavailable = await harness.app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { ...auth, "idempotency-key": "request-0002" },
        payload: { agentId: "missing", sessionKey: "session:missing", input: { type: "text", text: "hello" } },
      });
      expect(unavailable.statusCode).toBe(422);
      expect(unavailable.json()).toMatchObject({ code: "agent_unavailable" });

      const created = await harness.app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { ...auth, "idempotency-key": "request-0003" },
        payload: { agentId: "primary", sessionKey: "session:cancel", input: { type: "text", text: "hello" } },
      });
      const cancelled = await harness.app.inject({
        method: "POST",
        url: `/v1/runs/${created.json().runId}/cancel`,
        headers: auth,
      });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json()).toMatchObject({ runId: created.json().runId, status: "cancelled" });
    } finally {
      await harness.close();
    }
  });

  it("maps SQLite busy errors to a redacted 503 Problem Detail", async () => {
    const createRuns = {
      execute: () => { throw Object.assign(new Error("database is locked at C:\\secret\\kernel.db"), { errcode: 5 }); },
    } as unknown as CreateRunService;
    const runs = { getRun: () => { throw new Error("unused"); }, listEventsAfter: () => [] } as unknown as Pick<RunStore, "getRun" | "listEventsAfter">;
    const cancelRuns = { execute: () => { throw new Error("unused"); } } as unknown as CancelRunService;
    const app = createHttpApp({ bearerToken: "test-token", createRuns, runs, cancelRuns });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: auth,
        payload: { agentId: "primary", sessionKey: "session:busy", input: { type: "text", text: "hello" } },
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json()).toMatchObject({ code: "database_unavailable" });
      expect(response.payload).not.toContain("kernel.db");
      expect(response.payload).not.toContain("secret");
    } finally {
      await app.close();
    }
  });
});
