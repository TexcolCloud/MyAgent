import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DeleteSessionService } from "../../src/application/delete-session.js";
import type { CatalogSnapshot } from "../../src/config/catalog-loader.js";
import { DomainError } from "../../src/domain/errors.js";
import type { SessionId } from "../../src/domain/ids.js";
import { startTestApp } from "../helpers/start-test-app.js";

const headers = { authorization: "Bearer test-token", "idempotency-key": "request-0001" };

describe("HTTP catalog and session routes", () => {
  it("lists Agents and rejects unknown Run properties", async () => {
    const harness = await startTestApp();
    try {
      const agents = await harness.app.inject({ method: "GET", url: "/v1/agents", headers });
      expect(agents.statusCode).toBe(200);
      expect(agents.json().agents).toEqual(expect.arrayContaining([expect.objectContaining({ id: "primary" })]));
      const invalid = await harness.app.inject({ method: "POST", url: "/v1/runs", headers, payload: { agentId: "primary", sessionKey: "session:a", input: { type: "text", text: "hello" }, extra: true } });
      expect(invalid.statusCode).toBe(400);
      const reloaded = await harness.app.inject({ method: "POST", url: "/v1/config/reload", headers });
      expect(reloaded.statusCode).toBe(200);
      expect(reloaded.json().agents).toEqual(expect.arrayContaining([expect.objectContaining({ id: "primary" })]));
    } finally { await harness.close(); }
  });

  it("serializes malformed unavailable Agent source labels after reload", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "myagent-http-label-"));
    const configRoot = path.join(temporary, "config");
    await cp("test/fixtures/config/valid", configRoot, { recursive: true });
    const harness = await startTestApp({
      configPath: path.join(configRoot, "myagent.yaml"),
    });
    const agentPath = path.join(configRoot, "agents", "primary", "agent.yaml");
    await writeFile(
      agentPath,
      (await readFile(agentPath, "utf8")).replace("id: primary", "id: Bad Agent!"),
    );

    try {
      const reloaded = await harness.app.inject({
        method: "POST",
        url: "/v1/config/reload",
        headers,
      });
      expect(reloaded.statusCode).toBe(200);
      expect(reloaded.json().unavailable).toContainEqual({
        label: "Bad Agent!",
        code: "invalid_agent_config",
      });

      const listed = await harness.app.inject({
        method: "GET",
        url: "/v1/agents",
        headers,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().unavailable).toContainEqual({
        label: "Bad Agent!",
        code: "invalid_agent_config",
      });
      expect(harness.catalog.current().unavailable).toHaveLength(1);
    } finally {
      await harness.close();
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("validates the complete reload response before publishing its snapshot", async () => {
    const harness = await startTestApp();
    const active = harness.catalog.current();
    const candidate = {
      ...active,
      available: active.available.map((agent, index) => index === 0
        ? {
            ...agent,
            definition: { ...agent.definition, definitionRevisionId: 42 },
          }
        : agent),
    } as unknown as CatalogSnapshot;
    vi.spyOn(harness.catalog, "validate").mockResolvedValue(candidate);

    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/v1/config/reload",
        headers,
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ code: "internal_error" });
      expect(harness.catalog.current()).toBe(active);
    } finally {
      await harness.close();
    }
  });

  it("returns only Session lifecycle metadata and deletes an idle Session", async () => {
    const harness = await startTestApp();
    try {
      const created = await harness.app.inject({ method: "POST", url: "/v1/runs", headers, payload: { agentId: "primary", sessionKey: "session:a", input: { type: "text", text: "hello" } } });
      const sessionId = created.json().runId ? (await harness.app.inject({ method: "GET", url: `/v1/runs/${created.json().runId}`, headers })).json().sessionId : "";
      const listed = await harness.app.inject({ method: "GET", url: "/v1/sessions?agentId=primary&sessionKey=session:a", headers });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().sessions[0]).toMatchObject({ sessionId, agentId: "primary", sessionKey: "session:a" });
      expect(listed.json().sessions[0]).not.toHaveProperty("messages");
      expect((await harness.app.inject({ method: "DELETE", url: `/v1/sessions/${sessionId}`, headers })).statusCode).toBe(204);
    } finally { await harness.close(); }
  });

  it("refuses to delete a Session until its running Run is terminal", async () => {
    const harness = await startTestApp();
    try {
      const created = await harness.app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { ...headers, "idempotency-key": "request-running-delete" },
        payload: { agentId: "primary", sessionKey: "session:running-delete", input: { type: "text", text: "hello" } },
      });
      const run = harness.runs.getRun(created.json().runId);
      harness.connection.db.prepare("UPDATE runs SET state = 'running' WHERE run_id = ?").run(run.runId);

      const blocked = await harness.app.inject({ method: "DELETE", url: `/v1/sessions/${run.sessionId}`, headers });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json()).toMatchObject({ code: "session_has_running_run" });
      expect(harness.sessions.findByIdentity("primary", "session:running-delete")).not.toBeNull();

      harness.connection.db.prepare("UPDATE runs SET state = 'cancelled' WHERE run_id = ?").run(run.runId);
      expect((await harness.app.inject({ method: "DELETE", url: `/v1/sessions/${run.sessionId}`, headers })).statusCode).toBe(204);
    } finally {
      await harness.close();
    }
  });

  it("lists the exact normalized pending Approval and rejects an opposite decision", async () => {
    const harness = await startTestApp();
    try {
      const created = await harness.app.inject({
        method: "POST",
        url: "/v1/runs",
        headers,
        payload: { agentId: "primary", sessionKey: "session:approval", input: { type: "text", text: "hello" } },
      });
      const runId = created.json().runId as string;
      seedPendingApproval(harness.connection.db, runId);

      const listed = await harness.app.inject({ method: "GET", url: "/v1/approvals?status=pending", headers });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().approvals).toEqual([expect.objectContaining({
        approvalId: "approval-http-1",
        runId,
        toolName: "run_command",
        arguments: { args: ["hello"], program: "node" },
        riskNotice: "This command runs on the host and is not isolated by an OS sandbox.",
      })]);

      const approved = await harness.app.inject({
        method: "POST",
        url: "/v1/approvals/approval-http-1/decision",
        headers,
        payload: { decision: "approve" },
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json()).toMatchObject({ approvalId: "approval-http-1", state: "approved" });

      const opposite = await harness.app.inject({
        method: "POST",
        url: "/v1/approvals/approval-http-1/decision",
        headers,
        payload: { decision: "deny" },
      });
      expect(opposite.statusCode).toBe(409);
      expect(opposite.json()).toMatchObject({ code: "approval_already_resolved" });
    } finally {
      await harness.close();
    }
  });

  it("reconciles an unknown Tool Call through the HTTP boundary", async () => {
    const harness = await startTestApp();
    try {
      const created = await harness.app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { ...headers, "idempotency-key": "request-0002" },
        payload: { agentId: "primary", sessionKey: "session:reconcile", input: { type: "text", text: "hello" } },
      });
      const runId = created.json().runId as string;
      seedUnknownToolCall(harness.connection.db, runId);

      const reconciled = await harness.app.inject({
        method: "POST",
        url: "/v1/tool-calls/tool-http-unknown/reconciliation",
        headers,
        payload: { outcome: "succeeded", note: "verified", result: { ok: true } },
      });
      expect(reconciled.statusCode).toBe(200);
      expect(reconciled.json()).toEqual({ toolCallId: "tool-http-unknown", state: "succeeded" });
      expect(harness.runs.getRun(runId as never).state).toBe("queued");
    } finally {
      await harness.close();
    }
  });

  it.each(["succeeded", "failed"] as const)(
    "records a %s unknown-Tool outcome after Run cancellation without reopening it",
    async (outcome) => {
      const harness = await startTestApp();
      try {
        const created = await harness.app.inject({
          method: "POST",
          url: "/v1/runs",
          headers: {
            ...headers,
            "idempotency-key": `request-cancelled-${outcome}`,
          },
          payload: {
            agentId: "primary",
            sessionKey: `session:cancelled-${outcome}`,
            input: { type: "text", text: "cancel before reconciliation" },
          },
        });
        const runId = created.json().runId as string;
        const toolCallId = `tool-http-cancelled-${outcome}`;
        seedUnknownToolCall(harness.connection.db, runId, toolCallId);
        const cancelled = await harness.app.inject({
          method: "POST",
          url: `/v1/runs/${runId}/cancel`,
          headers,
        });
        expect(cancelled.statusCode).toBe(200);
        expect(cancelled.json()).toMatchObject({ status: "cancelled" });
        const queuedEventsBeforeReconciliation = harness.runs
          .listEventsAfter(runId as never, 0)
          .filter((event) => event.type === "run.queued").length;

        const payload = {
          outcome,
          note: `operator observed ${outcome}`,
          result: { observed: outcome },
        };
        const first = await harness.app.inject({
          method: "POST",
          url: `/v1/tool-calls/${toolCallId}/reconciliation`,
          headers,
          payload,
        });
        expect(first.statusCode).toBe(200);
        expect(first.json()).toEqual({
          toolCallId,
          state: outcome,
        });
        const eventsAfterFirst = harness.runs.listEventsAfter(runId as never, 0);

        const repeated = await harness.app.inject({
          method: "POST",
          url: `/v1/tool-calls/${toolCallId}/reconciliation`,
          headers,
          payload,
        });

        expect(repeated.statusCode).toBe(200);
        expect(harness.runs.getRun(runId as never).state).toBe("cancelled");
        expect(harness.tools.get(toolCallId as never).state).toBe(outcome);
        expect(harness.runs.listEventsAfter(runId as never, 0))
          .toHaveLength(eventsAfterFirst.length);
        expect(eventsAfterFirst.map((event) => event.type)).toContain(
          outcome === "succeeded" ? "tool.completed" : "tool.failed",
        );
        expect(
          eventsAfterFirst.filter((event) => event.type === "run.queued"),
        ).toHaveLength(queuedEventsBeforeReconciliation);
      } finally {
        await harness.close();
      }
    },
  );

  it("rejects retry for a cancelled Run without creating unexecutable work", async () => {
    const harness = await startTestApp();
    try {
      const created = await harness.app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { ...headers, "idempotency-key": "request-cancelled-retry" },
        payload: {
          agentId: "primary",
          sessionKey: "session:cancelled-retry",
          input: { type: "text", text: "do not retry after cancellation" },
        },
      });
      const runId = created.json().runId as string;
      const toolCallId = "tool-http-cancelled-retry";
      seedUnknownToolCall(harness.connection.db, runId, toolCallId);
      await harness.app.inject({
        method: "POST",
        url: `/v1/runs/${runId}/cancel`,
        headers,
      });

      const retried = await harness.app.inject({
        method: "POST",
        url: `/v1/tool-calls/${toolCallId}/reconciliation`,
        headers,
        payload: { outcome: "retry", note: "operator requested retry" },
      });

      expect(retried.statusCode).toBe(409);
      expect(retried.json()).toMatchObject({
        code: "reconciliation_retry_cancelled_run",
      });
      expect(harness.runs.getRun(runId as never).state).toBe("cancelled");
      expect(harness.tools.get(toolCallId as never).state).toBe("unknown");
      expect(harness.connection.db.prepare(
        `SELECT COUNT(*) AS count FROM tool_calls
         WHERE run_id = ? AND retry_of_tool_call_id IS NOT NULL`,
      ).get(runId)).toEqual({ count: 0 });
      expect(harness.connection.db.prepare(
        "SELECT COUNT(*) AS count FROM reconciliations WHERE tool_call_id = ?",
      ).get(toolCallId)).toEqual({ count: 0 });
    } finally {
      await harness.close();
    }
  });

  it("preserves a retry reconciliation across later Run cancellation", async () => {
    const harness = await startTestApp();
    try {
      const created = await harness.app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: {
          ...headers,
          "idempotency-key": "request-retry-then-cancel",
        },
        payload: {
          agentId: "primary",
          sessionKey: "session:retry-then-cancel",
          input: { type: "text", text: "retry before cancellation" },
        },
      });
      const runId = created.json().runId as string;
      const toolCallId = "tool-http-retry-then-cancel";
      const payload = {
        outcome: "retry",
        note: "operator requested one retry",
      } as const;
      seedUnknownToolCall(harness.connection.db, runId, toolCallId);

      const first = await harness.app.inject({
        method: "POST",
        url: `/v1/tool-calls/${toolCallId}/reconciliation`,
        headers,
        payload,
      });
      expect(first.statusCode).toBe(200);
      const firstBody = first.json() as {
        toolCallId: string;
        state: string;
        retryToolCallId: string;
      };
      expect(firstBody).toMatchObject({
        toolCallId,
        state: "unknown",
        retryToolCallId: expect.stringMatching(/^call_/),
      });

      const cancelled = await harness.app.inject({
        method: "POST",
        url: `/v1/runs/${runId}/cancel`,
        headers,
      });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json()).toMatchObject({ status: "cancelled" });
      const footprintAfterCancellation = reconciliationFootprint(
        harness.connection.db,
        runId,
        toolCallId,
      );

      const replayed = await harness.app.inject({
        method: "POST",
        url: `/v1/tool-calls/${toolCallId}/reconciliation`,
        headers,
        payload,
      });

      expect(replayed.statusCode).toBe(200);
      expect(replayed.json()).toEqual(firstBody);
      expect(reconciliationFootprint(
        harness.connection.db,
        runId,
        toolCallId,
      )).toEqual(footprintAfterCancellation);
      expect(harness.runs.getRun(runId as never).state).toBe("cancelled");
      expect(harness.tools.get(firstBody.retryToolCallId as never).state)
        .toBe("denied");

      const opposite = await harness.app.inject({
        method: "POST",
        url: `/v1/tool-calls/${toolCallId}/reconciliation`,
        headers,
        payload: {
          outcome: "failed",
          note: "operator changed the decision",
        },
      });
      expect(opposite.statusCode).toBe(409);
      expect(opposite.json()).toMatchObject({
        code: "tool_call_already_reconciled",
      });
      expect(reconciliationFootprint(
        harness.connection.db,
        runId,
        toolCallId,
      )).toEqual(footprintAfterCancellation);
      expect(harness.runs.getRun(runId as never).state).toBe("cancelled");
    } finally {
      await harness.close();
    }
  });

  it("delegates the deletion decision to one atomic store operation", () => {
    const sessionId = "session-atomic" as SessionId;
    const deleteIfIdle = vi.fn(() => { throw new DomainError("session_has_running_run"); });
    const service = new DeleteSessionService({ deleteIfIdle });

    expect(() => service.execute(sessionId)).toThrowError(expect.objectContaining({ code: "session_has_running_run" }));
    expect(deleteIfIdle).toHaveBeenCalledExactlyOnceWith(sessionId);
  });
});

function seedPendingApproval(db: import("node:sqlite").DatabaseSync, runId: string): void {
  const now = "2026-08-07T00:00:00.000Z";
  db.prepare("UPDATE runs SET state = 'waiting_approval' WHERE run_id = ?").run(runId);
  db.prepare(`INSERT INTO tool_calls (
    tool_call_id, run_id, state, tool_name, effect, arguments_json,
    canonical_arguments, arguments_sha256, policy_effect, matched_rule,
    policy_facts_json, created_at, updated_at
  ) VALUES (?, ?, 'waiting_approval', 'run_command', 'side_effect', ?, ?, 'hash-http-1', 'ask', 0, '{}', ?, ?)`)
    .run("tool-http-approval", runId, '{"args":["hello"],"program":"node"}', '{"args":["hello"],"program":"node"}', now, now);
  db.prepare(`INSERT INTO approvals (
    approval_id, run_id, tool_call_id, state, arguments_sha256, expires_at, created_at
  ) VALUES ('approval-http-1', ?, 'tool-http-approval', 'pending', 'hash-http-1', ?, ?)`)
    .run(runId, "2026-08-08T00:00:00.000Z", now);
}

function seedUnknownToolCall(
  db: import("node:sqlite").DatabaseSync,
  runId: string,
  toolCallId = "tool-http-unknown",
): void {
  const now = "2026-08-07T00:00:00.000Z";
  db.prepare("UPDATE runs SET state = 'waiting_reconciliation' WHERE run_id = ?").run(runId);
  db.prepare(`INSERT INTO tool_calls (
    tool_call_id, run_id, state, tool_name, effect, arguments_json,
    canonical_arguments, arguments_sha256, policy_effect, matched_rule,
    policy_facts_json, created_at, updated_at
  ) VALUES (?, ?, 'unknown', 'write_file', 'side_effect', ?, ?, 'hash-http-2', 'allow', 0, '{}', ?, ?)`)
    .run(toolCallId, runId, '{"content":"x","path":"report.txt"}', '{"content":"x","path":"report.txt"}', now, now);
}

function reconciliationFootprint(
  db: import("node:sqlite").DatabaseSync,
  runId: string,
  toolCallId: string,
): { toolCalls: number; reconciliations: number; events: number } {
  const count = (query: string, value: string): number => (
    db.prepare(query).get(value) as { count: number }
  ).count;
  return {
    toolCalls: count(
      "SELECT COUNT(*) AS count FROM tool_calls WHERE run_id = ?",
      runId,
    ),
    reconciliations: count(
      "SELECT COUNT(*) AS count FROM reconciliations WHERE tool_call_id = ?",
      toolCallId,
    ),
    events: count(
      "SELECT COUNT(*) AS count FROM run_events WHERE run_id = ?",
      runId,
    ),
  };
}
