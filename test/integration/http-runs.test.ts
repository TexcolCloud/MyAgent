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

  it("lists only active durable impact without mutating Run state", async () => {
    const harness = await startTestApp({
      databasePath: tempPath("http-active-runs.db"),
    });
    try {
      const create = async (key: string, sessionKey: string) => {
        const response = await harness.app.inject({
          method: "POST",
          url: "/v1/runs",
          headers: { ...auth, "idempotency-key": key },
          payload: {
            agentId: "primary",
            sessionKey,
            input: { type: "text", text: key },
          },
        });
        return response.json().runId as RunId;
      };
      const queuedRunId = await create("request-active-queued", "session:active-queued");
      const runningRunId = await create("request-active-running", "session:active-running");
      const waitingRunId = await create("request-active-waiting", "session:active-waiting");
      const cancellingRunId = await create("request-active-cancelling", "session:active-cancelling");
      const completedRunId = await create("request-active-completed", "session:active-completed");
      const reconciliationRunId = await create("request-active-reconciliation", "session:active-reconciliation");
      const now = harness.clock.now();
      harness.connection.db.prepare(
        "UPDATE runs SET state = 'running', created_at = ? WHERE run_id = ?",
      ).run("2026-08-07T00:00:02.000Z", runningRunId);
      harness.connection.db.prepare(
        "UPDATE runs SET state = 'waiting_approval', created_at = ? WHERE run_id = ?",
      ).run("2026-08-07T00:00:03.000Z", waitingRunId);
      harness.connection.db.prepare(
        "UPDATE runs SET state = 'running', cancellation_requested_at = ?, created_at = ? WHERE run_id = ?",
      ).run(now.toISOString(), "2026-08-07T00:00:04.000Z", cancellingRunId);
      harness.connection.db.prepare(
        "UPDATE runs SET state = 'completed', output_json = ? WHERE run_id = ?",
      ).run('{"type":"text","text":"done"}', completedRunId);
      harness.connection.db.prepare(
        "UPDATE runs SET state = 'waiting_reconciliation' WHERE run_id = ?",
      ).run(reconciliationRunId);
      harness.connection.db.prepare(
        "UPDATE runs SET created_at = ? WHERE run_id = ?",
      ).run("2026-08-07T00:00:01.000Z", queuedRunId);
      const before = harness.connection.db.prepare(
        "SELECT run_id, state, cancellation_requested_at FROM runs ORDER BY run_id",
      ).all();

      const response = await harness.app.inject({
        method: "GET",
        url: "/v1/runs?state=active",
        headers: auth,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { runs: unknown[] };
      expect(body.runs).toEqual([
        { runId: queuedRunId, status: "queued" },
        { runId: runningRunId, status: "running" },
        { runId: waitingRunId, status: "waiting_approval" },
        { runId: cancellingRunId, status: "cancelling" },
      ]);
      expect(harness.connection.db.prepare(
        "SELECT run_id, state, cancellation_requested_at FROM runs ORDER BY run_id",
      ).all()).toEqual(before);
    } finally {
      await harness.close();
    }
  });

  it("lists durable Run history by Agent and Session newest first with an opaque cursor", async () => {
    const harness = await startTestApp({ databasePath: tempPath("http-run-history.db") });
    try {
      const create = async (idempotencyKey: string, agentId: string, sessionKey: string) => {
        const response = await harness.app.inject({
          method: "POST", url: "/v1/runs", headers: { ...auth, "idempotency-key": idempotencyKey },
          payload: { agentId, sessionKey, input: { type: "text", text: idempotencyKey } },
        });
        return response.json().runId as RunId;
      };
      const first = await create("history-primary-first", "primary", "session:history");
      const second = await create("history-primary-second", "primary", "session:history");
      await create("history-primary-other", "primary", "session:other");
      const timestamp = "2026-08-13T10:00:00.000Z";
      harness.connection.db.prepare("UPDATE runs SET updated_at = ? WHERE run_id IN (?, ?)")
        .run(timestamp, first, second);

      const page = await harness.app.inject({
        method: "GET",
        url: "/v1/runs?agentId=primary&sessionKey=session%3Ahistory&limit=1",
        headers: auth,
      });

      expect(page.statusCode).toBe(200);
      expect(page.json()).toMatchObject({
        items: [{ runId: [first, second].sort().reverse()[0] }],
        nextCursor: expect.any(String),
      });
      const next = await harness.app.inject({
        method: "GET",
        url: `/v1/runs?agentId=primary&sessionKey=session%3Ahistory&limit=100&cursor=${encodeURIComponent(page.json().nextCursor)}`,
        headers: auth,
      });
      expect(next.statusCode).toBe(200);
      expect(next.json().items).toMatchObject([{ runId: [first, second].sort().reverse()[1] }]);
    } finally {
      await harness.close();
    }
  });

  it("rejects noncanonical history cursors before SQLite enumeration", async () => {
    const harness = await startTestApp();
    try {
      for (const cursor of ["not-base64", Buffer.from('{"updatedAt":"2026-08-13T00:00:00Z","runId":"run_x"}').toString("base64url"), Buffer.from('{"runId":"run_x","updatedAt":"2026-08-13T00:00:00.000Z","extra":true}').toString("base64url"), Buffer.from('{"updatedAt":"2026-08-13T00:00:00.000Z","runId":"ses_wrong_kind"}').toString("base64url"), Buffer.from('{"updatedAt":"2026-08-13T00:00:00.000Z","runId":"run_arbitrary"}').toString("base64url")]) {
        const response = await harness.app.inject({ method: "GET", url: `/v1/runs?agentId=primary&sessionKey=session%3Ahistory&cursor=${encodeURIComponent(cursor)}`, headers: auth });
        expect(response.statusCode).toBe(400);
      }
      const sessionCursor = Buffer.from('{"updatedAt":"2026-08-13T00:00:00.000Z","sessionId":"run_wrong_kind"}').toString("base64url");
      const sessionResponse = await harness.app.inject({ method: "GET", url: `/v1/sessions?cursor=${encodeURIComponent(sessionCursor)}`, headers: auth });
      expect(sessionResponse.statusCode).toBe(400);
    } finally { await harness.close(); }
  });

  it.each([
    ["missing state", "/v1/runs"],
    ["wrong state", "/v1/runs?state=completed"],
    ["extra query", "/v1/runs?state=active&limit=1"],
    ["duplicate state", "/v1/runs?state=active&state=active"],
  ])("rejects %s on the active Run boundary", async (_label, url) => {
    const harness = await startTestApp();
    try {
      const response = await harness.app.inject({ method: "GET", url, headers: auth });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request" });
    } finally {
      await harness.close();
    }
  });

  it("requires Run authentication for active impact inspection", async () => {
    const harness = await startTestApp();
    try {
      const response = await harness.app.inject({
        method: "GET",
        url: "/v1/runs?state=active",
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: "unauthorized" });
    } finally {
      await harness.close();
    }
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
      const unconfirmed = await harness.app.inject({
        method: "POST",
        url: `/v1/runs/${created.json().runId}/cancel`,
        headers: auth,
        payload: {},
      });
      expect(unconfirmed.statusCode).toBe(400);
      const detail = await harness.app.inject({ method: "GET", url: `/v1/runs/${created.json().runId}`, headers: auth });
      const cancelled = await harness.app.inject({
        method: "POST",
        url: `/v1/runs/${created.json().runId}/cancel`,
        headers: auth,
        payload: { confirm: true, expectedRevision: detail.json().updatedAt },
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
    const runs = {
      getRun: () => { throw new Error("unused"); },
      listActiveRuns: () => [],
      listHistory: () => ({ items: [] }),
      listEventsAfter: () => [],
    } as unknown as Pick<RunStore, "getRun" | "listActiveRuns" | "listHistory" | "listEventsAfter">;
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
