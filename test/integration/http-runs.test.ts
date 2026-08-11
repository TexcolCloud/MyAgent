import { describe, expect, it } from "vitest";

import type { CancelRunService } from "../../src/application/cancel-run.js";
import type { CreateRunService } from "../../src/application/create-run.js";
import type { AttemptId, RunId } from "../../src/domain/ids.js";
import { createHttpApp } from "../../src/interfaces/http/app.js";
import type { RunStore } from "../../src/ports/run-store.js";
import { startTestApp } from "../helpers/start-test-app.js";
import { tempPath } from "../helpers/temp-dir.js";

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
      expect(unavailable.json()).toEqual({
        type: "about:blank",
        title: "Unprocessable Content",
        status: 422,
        code: "agent_unavailable",
        detail: "The requested Agent is unavailable.",
        traceId: expect.any(String),
      });

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

  it("returns a completed Run's parsed terminal result", async () => {
    const harness = await startTestApp({
      databasePath: tempPath("http-completed-result.db"),
    });
    try {
      const created = await harness.app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { ...auth, "idempotency-key": "request-completed-result" },
        payload: {
          agentId: "primary",
          sessionKey: "session:completed-result",
          input: { type: "text", text: "complete me" },
        },
      });
      const runId = created.json().runId as RunId;
      const occurredAt = harness.clock.now();
      expect(harness.runs.claimNextEligible(
        "http-completed-worker",
        occurredAt,
        new Date(occurredAt.getTime() + 30_000),
      )?.runId).toBe(runId);
      harness.runs.completeRun({
        runId,
        leaseOwner: "http-completed-worker",
        attemptId: "attempt-http-completed" as AttemptId,
        text: "durable terminal output",
        finishReason: "completed",
        usage: { inputTokens: 4, outputTokens: 3 },
        occurredAt,
      });

      const response = await harness.app.inject({
        method: "GET",
        url: `/v1/runs/${runId}`,
        headers: auth,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        runId,
        status: "completed",
        result: { type: "text", text: "durable terminal output" },
      });
      expect(response.json()).not.toHaveProperty("failure");
    } finally {
      await harness.close();
    }
  });

  it("returns only allowlisted typed redacted failures for failed Runs", async () => {
    const harness = await startTestApp({
      databasePath: tempPath("http-failed-result.db"),
    });
    try {
      const created = await harness.app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { ...auth, "idempotency-key": "request-failed-result" },
        payload: {
          agentId: "primary",
          sessionKey: "session:failed-result",
          input: { type: "text", text: "fail me" },
        },
      });
      const runId = created.json().runId as RunId;
      const occurredAt = harness.clock.now();
      expect(harness.runs.claimNextEligible(
        "http-failed-worker",
        occurredAt,
        new Date(occurredAt.getTime() + 30_000),
      )?.runId).toBe(runId);
      harness.runs.failRun({
        runId,
        leaseOwner: "http-failed-worker",
        code: "run_budget_exceeded",
        occurredAt,
      });

      for (const publicCode of [
        "run_budget_exceeded",
        "model_protocol_error",
        "tool_not_found",
        "provider_unavailable",
      ]) {
        harness.connection.db.prepare(
          "UPDATE runs SET failure_code = ? WHERE run_id = ?",
        ).run(publicCode, runId);
        const failed = await harness.app.inject({
          method: "GET",
          url: `/v1/runs/${runId}`,
          headers: auth,
        });
        expect(failed.statusCode).toBe(200);
        expect(failed.json()).toMatchObject({
          runId,
          status: "failed",
          failure: { code: publicCode },
        });
        expect(failed.json()).not.toHaveProperty("result");
      }

      for (const privateCode of [
        "sk_live_SUPERSECRET",
        "provider_request_invalid",
        "custom_terminal_failure",
        "provider leaked SECRET_VALUE at C:\\private\\kernel.db",
      ]) {
        harness.connection.db.prepare(
          "UPDATE runs SET failure_code = ? WHERE run_id = ?",
        ).run(privateCode, runId);
        const redacted = await harness.app.inject({
          method: "GET",
          url: `/v1/runs/${runId}`,
          headers: auth,
        });
        expect(redacted.statusCode).toBe(200);
        expect(redacted.json().failure).toEqual({ code: "run_failed" });
        expect(redacted.payload).not.toContain(privateCode);
      }
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
