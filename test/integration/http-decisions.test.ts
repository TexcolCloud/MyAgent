import { describe, expect, it, vi } from "vitest";

import { DeleteSessionService } from "../../src/application/delete-session.js";
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

function seedUnknownToolCall(db: import("node:sqlite").DatabaseSync, runId: string): void {
  const now = "2026-08-07T00:00:00.000Z";
  db.prepare("UPDATE runs SET state = 'waiting_reconciliation' WHERE run_id = ?").run(runId);
  db.prepare(`INSERT INTO tool_calls (
    tool_call_id, run_id, state, tool_name, effect, arguments_json,
    canonical_arguments, arguments_sha256, policy_effect, matched_rule,
    policy_facts_json, created_at, updated_at
  ) VALUES ('tool-http-unknown', ?, 'unknown', 'write_file', 'side_effect', ?, ?, 'hash-http-2', 'allow', 0, '{}', ?, ?)`)
    .run(runId, '{"content":"x","path":"report.txt"}', '{"content":"x","path":"report.txt"}', now, now);
}
