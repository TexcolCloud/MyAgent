import { writeFile } from "node:fs/promises";
import path from "node:path";

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  AgentHttpClient,
  E2eServiceController,
  prepareE2eFixture,
  ScriptedChatServer,
  type ProviderTurn,
} from "../helpers/fault-controller.js";

describe("M1 release isolation and queue cases", () => {
  it("coalesces concurrent duplicate HTTP creates into one Run", async () => {
    const provider = await ScriptedChatServer.start([
      { type: "text", text: "one durable response" },
    ]);
    const fixture = await prepareE2eFixture(provider.baseUrl);
    const service = new E2eServiceController(fixture.configPath);
    const client = new AgentHttpClient(() => service.url);

    try {
      await service.start();
      const creates = await Promise.all(Array.from({ length: 16 }, () =>
        client.createRun({
          agentId: "primary",
          sessionKey: "release:duplicate",
          text: "create exactly once",
          idempotencyKey: "release-duplicate-0001",
        })));
      const runIds = new Set(creates.map((run) => run.runId));
      expect(runIds.size).toBe(1);
      const runId = creates[0]!.runId;
      await client.waitForStatus(runId, "completed", 20_000);

      expect(countRows(
        fixture.databasePath,
        `SELECT COUNT(*) AS count
         FROM runs JOIN sessions USING (session_id)
         WHERE agent_id = 'primary' AND session_key = 'release:duplicate'`,
      )).toBe(1);
      expect(provider.requests).toHaveLength(1);
    } finally {
      await service.stop();
      await fixture.cleanup();
      await provider.close();
    }
  }, 30_000);

  it("isolates messages, Skills, Tool results, and child context for the same Session Key across Agents", async () => {
    const turns: ProviderTurn[] = [
      { type: "tool", name: "activate_skill", arguments: { skillName: "research" } },
      { type: "tool", name: "read_file", arguments: { path: "identity.txt" } },
      {
        type: "tool",
        name: "delegate_agent",
        arguments: {
          targetAgentId: "researcher",
          task: "Return a context-isolated review.",
          context: {},
        },
      },
      { type: "text", text: "child isolated response" },
      { type: "text", text: "primary isolated response" },
      { type: "tool", name: "activate_skill", arguments: { skillName: "research" } },
      { type: "tool", name: "read_file", arguments: { path: "identity.txt" } },
      { type: "text", text: "researcher isolated response" },
      { type: "text", text: "primary summary-isolated response" },
      { type: "text", text: "researcher summary-isolated response" },
    ];
    const provider = await ScriptedChatServer.start(turns);
    const fixture = await prepareE2eFixture(provider.baseUrl);
    const service = new E2eServiceController(fixture.configPath);
    const client = new AgentHttpClient(() => service.url);

    try {
      await Promise.all([
        writeFile(
          path.join(fixture.primaryWorkspace, "identity.txt"),
          "PRIMARY_WORKSPACE_MARKER\n",
          "utf8",
        ),
        writeFile(
          path.join(fixture.researcherWorkspace, "identity.txt"),
          "RESEARCHER_WORKSPACE_MARKER\n",
          "utf8",
        ),
      ]);
      await service.start();
      const primary = await client.createRun({
        agentId: "primary",
        sessionKey: "release:same-key",
        text: "primary-root-secret",
        idempotencyKey: "release-isolation-primary-0001",
      });
      await client.waitForStatus(primary.runId, "completed", 20_000);
      const researcher = await client.createRun({
        agentId: "researcher",
        sessionKey: "release:same-key",
        text: "researcher-root-secret",
        idempotencyKey: "release-isolation-researcher-0001",
      });
      await client.waitForStatus(researcher.runId, "completed", 20_000);

      await service.stop();
      seedSessionSummaries(fixture.databasePath, "release:same-key");
      await service.start();
      const primarySummaryProbe = await client.createRun({
        agentId: "primary",
        sessionKey: "release:same-key",
        text: "continue from the primary summary",
        idempotencyKey: "release-isolation-primary-summary-0001",
      });
      await client.waitForStatus(primarySummaryProbe.runId, "completed", 20_000);
      const researcherSummaryProbe = await client.createRun({
        agentId: "researcher",
        sessionKey: "release:same-key",
        text: "continue from the researcher summary",
        idempotencyKey: "release-isolation-researcher-summary-0001",
      });
      await client.waitForStatus(researcherSummaryProbe.runId, "completed", 20_000);

      expect(provider.requests).toHaveLength(turns.length);
      const requests = provider.requests.map((request) => JSON.stringify(request));
      expect(requests.every((request) =>
        !(request.includes("primary-root-secret") && request.includes("researcher-root-secret")),
      )).toBe(true);
      expect(requests[3]).not.toContain("primary-root-secret");
      expect(requests.slice(0, 5).join("\n")).not.toContain("RESEARCHER_WORKSPACE_MARKER");
      expect(requests.slice(5).join("\n")).not.toContain("PRIMARY_WORKSPACE_MARKER");
      expect(requests[8]).toContain("PRIMARY_SUMMARY_MARKER");
      expect(requests[8]).not.toContain("RESEARCHER_SUMMARY_MARKER");
      expect(requests[9]).toContain("RESEARCHER_SUMMARY_MARKER");
      expect(requests[9]).not.toContain("PRIMARY_SUMMARY_MARKER");

      const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
      try {
        const sessions = database.prepare(
          `SELECT session_id, agent_id FROM sessions
           WHERE session_key = 'release:same-key' ORDER BY agent_id`,
        ).all() as Array<{ session_id: string; agent_id: string }>;
        expect(sessions).toHaveLength(2);
        expect(new Set(sessions.map((session) => session.agent_id)))
          .toEqual(new Set(["primary", "researcher"]));
        for (const session of sessions) {
          const serialized = JSON.stringify(database.prepare(
            "SELECT role, content_json FROM messages WHERE session_id = ? ORDER BY sequence",
          ).all(session.session_id));
          const otherSecret = session.agent_id === "primary"
            ? "researcher-root-secret"
            : "primary-root-secret";
          expect(serialized).not.toContain(otherSecret);
        }
        expect(database.prepare(
          "SELECT COUNT(*) AS count FROM run_activated_skills WHERE run_id IN (?, ?)",
        ).get(primary.runId, researcher.runId)).toEqual({ count: 2 });
        expect(JSON.stringify(database.prepare(
          "SELECT run_id, result_json FROM tool_calls WHERE run_id IN (?, ?)",
        ).all(primary.runId, researcher.runId))).toContain("WORKSPACE_MARKER");
        expect(database.prepare(
          "SELECT COUNT(*) AS count FROM runs WHERE parent_run_id = ?",
        ).get(primary.runId)).toEqual({ count: 1 });
        expect(database.prepare(
          "SELECT COUNT(*) AS count FROM runs WHERE parent_run_id = ?",
        ).get(researcher.runId)).toEqual({ count: 0 });
        expect(database.prepare(
          `SELECT COUNT(*) AS count FROM session_summaries AS summary
           JOIN sessions AS session ON session.session_id = summary.session_id
           WHERE session.session_key = 'release:same-key'`,
        ).get()).toEqual({ count: 2 });
      } finally {
        database.close();
      }
    } finally {
      await service.stop();
      await fixture.cleanup();
      await provider.close();
    }
  }, 40_000);

  it("keeps a Session FIFO blocked on Approval while another Session completes", async () => {
    const provider = await ScriptedChatServer.start([
      {
        type: "tool",
        name: "write_file",
        arguments: {
          path: "approval.txt",
          content: "must be approved\n",
          expectedSha256: null,
        },
      },
      { type: "text", text: "independent Session completed" },
    ]);
    const fixture = await prepareE2eFixture(provider.baseUrl);
    const service = new E2eServiceController(fixture.configPath);
    const client = new AgentHttpClient(() => service.url);

    try {
      await service.start();
      const waiting = await client.createRun({
        agentId: "primary",
        sessionKey: "release:fifo",
        text: "first Run waits for Approval",
        idempotencyKey: "release-fifo-0001",
      });
      await client.waitForEvent(waiting.runId, "approval.required");
      const blocked = await client.createRun({
        agentId: "primary",
        sessionKey: "release:fifo",
        text: "second Run must remain queued",
        idempotencyKey: "release-fifo-0002",
      });
      const independent = await client.createRun({
        agentId: "primary",
        sessionKey: "release:independent",
        text: "another Session may proceed",
        idempotencyKey: "release-fifo-0003",
      });

      await client.waitForStatus(independent.runId, "completed", 20_000);
      expect(await client.getRun(waiting.runId)).toMatchObject({
        status: "waiting_approval",
      });
      expect(await client.getRun(blocked.runId)).toMatchObject({ status: "queued" });
      expect(JSON.stringify(provider.requests)).not.toContain("second Run must remain queued");
      expect(provider.requests).toHaveLength(2);
    } finally {
      await service.stop();
      await fixture.cleanup();
      await provider.close();
    }
  }, 30_000);
});

function countRows(databasePath: string, statement: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (database.prepare(statement).get() as { count: number }).count;
  } finally {
    database.close();
  }
}

function seedSessionSummaries(databasePath: string, sessionKey: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    const sessions = database.prepare(
      "SELECT session_id, agent_id FROM sessions WHERE session_key = ? ORDER BY agent_id",
    ).all(sessionKey) as Array<{ session_id: string; agent_id: string }>;
    if (sessions.length !== 2) throw new Error("summary_fixture_sessions_missing");
    const bounds = database.prepare(
      "SELECT MIN(sequence) AS first, MAX(sequence) AS last FROM messages WHERE session_id = ?",
    );
    const insert = database.prepare(
      `INSERT INTO session_summaries (
         summary_id, session_id, from_message_sequence, to_message_sequence,
         content, model_provider, model_name, created_at
       ) VALUES (?, ?, ?, ?, ?, 'openai-compatible', 'test-model', ?)`,
    );
    const updateCurrentSummary = database.prepare(
      "UPDATE sessions SET current_summary_id = ?, updated_at = ? WHERE session_id = ?",
    );
    const occurredAt = new Date(0).toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const session of sessions) {
        const range = bounds.get(session.session_id) as {
          first: number | null;
          last: number | null;
        };
        if (range.first === null || range.last === null) {
          throw new Error("summary_fixture_messages_missing");
        }
        const summaryId = `summary:e2e:${session.agent_id}`;
        const content = session.agent_id === "primary"
          ? "PRIMARY_SUMMARY_MARKER"
          : "RESEARCHER_SUMMARY_MARKER";
        insert.run(
          summaryId,
          session.session_id,
          range.first,
          range.last,
          content,
          occurredAt,
        );
        updateCurrentSummary.run(summaryId, occurredAt, session.session_id);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}
