import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";

import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";

import { startTestApp } from "../helpers/start-test-app.js";
import { tempPath } from "../helpers/temp-dir.js";

describe("CLI HTTP boundary", () => {
  it("loads local config validation without importing SQLite", async () => {
    vi.resetModules();
    vi.doMock("node:sqlite", () => {
      throw new Error("cli_imported_sqlite");
    });
    try {
      const { executeCli } = await import("../../src/interfaces/cli/main.js");
      const fetcher = vi.fn();
      const write = vi.fn();
      const configPath = fileURLToPath(new URL("../fixtures/config/valid/myagent.yaml", import.meta.url));

      await executeCli(["config", "validate", "--config", configPath], { fetcher, write });

      expect(fetcher).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledWith(expect.stringContaining("primary"));
    } finally {
      vi.doUnmock("node:sqlite");
      vi.resetModules();
    }
  });

  it("runs every operational command through the authenticated HTTP API", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const harness = await startTestApp();
    const output: string[] = [];
    let watchRequests = 0;
    const fetcher = injectFetcher(harness.app, (url) => {
      if (url.pathname.endsWith("/events")) {
        watchRequests += 1;
        if (watchRequests > 1) throw new Error("unexpected_terminal_reconnect");
      }
    });
    const options = {
      environment: {
        MYAGENT_API_URL: "http://127.0.0.1:8787",
        MYAGENT_BEARER_TOKEN: "test-token",
      },
      fetcher,
      write: (line: string) => { output.push(line); },
    };

    try {
      await executeCli(["agents", "list"], options);
      await executeCli(["config", "reload"], options);
      await executeCli(["run", "create", "--agent", "primary", "--session", "cli:test", "--text", "hello"], options);
      const created = JSON.parse(output.at(-1)!) as { runId: string };
      const sessionId = harness.runs.getRun(created.runId as never).sessionId;

      await executeCli(["run", "cancel", created.runId], options);
      await executeCli(["run", "watch", created.runId], options);
      await executeCli(["sessions", "list", "--agent", "primary", "--session", "cli:test"], options);

      const approvalRunA = await createRun(harness.app, "cli:approval:a", "cli-approval-request-a");
      const approvalRunB = await createRun(harness.app, "cli:approval:b", "cli-approval-request-b");
      seedPendingApproval(harness.connection.db, approvalRunA, "a");
      seedPendingApproval(harness.connection.db, approvalRunB, "b");
      await executeCli(["approvals", "list"], options);
      const approvalList = JSON.parse(output.at(-1)!) as { approvals: unknown[] };
      await executeCli(["approvals", "approve", "approval-cli-a"], options);
      await executeCli(["approvals", "deny", "approval-cli-b"], options);

      for (const outcome of ["succeeded", "failed", "retry"] as const) {
        const runId = await createRun(harness.app, `cli:reconcile:${outcome}`, `cli-reconcile-${outcome}`);
        seedUnknownToolCall(harness.connection.db, runId, outcome);
        await executeCli(["tools", "reconcile", `tool-cli-${outcome}`, "--as", outcome], options);
      }

      await executeCli(["sessions", "delete", sessionId], options);
      const backupDestination = tempPath(`cli-backup-${randomUUID()}`);
      await executeCli(["backup", backupDestination], options);

      expect(watchRequests).toBe(1);
      expect(approvalList.approvals).toEqual(expect.arrayContaining([
        expect.objectContaining({
          approvalId: "approval-cli-a",
          toolName: "run_command",
          arguments: { args: ["hello"], program: "node" },
          riskNotice: "This command runs on the host and is not isolated by an OS sandbox.",
        }),
      ]));
      expect(output.some((line) => line.includes('"database":"kernel.db"'))).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("stops watching after a terminal Run event", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(
        "id: 9\nevent: run.completed\ndata: {\"type\":\"run.completed\"}\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ))
      .mockRejectedValue(new Error("unexpected_terminal_reconnect"));
    const write = vi.fn();

    await expect(executeCli(["run", "watch", "run-cli-1"], {
      environment: {
        MYAGENT_API_URL: "http://127.0.0.1:8787",
        MYAGENT_BEARER_TOKEN: "operator-token",
      },
      fetcher,
      write,
    })).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('{"type":"run.completed"}');
  });

  it("reconnects a non-terminal watch with the latest Event ID", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (fetcher.mock.calls.length === 1) {
        expect(new Headers(init?.headers).get("last-event-id")).toBeNull();
        return new Response(
          "id: 4\nevent: message.delta\ndata: {\"type\":\"message.delta\"}\n\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      expect(new Headers(init?.headers).get("last-event-id")).toBe("4");
      return new Response(
        "id: 5\nevent: run.failed\ndata: {\"type\":\"run.failed\"}\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const write = vi.fn();

    await executeCli(["run", "watch", "run-cli-1"], {
      environment: {
        MYAGENT_API_URL: "http://127.0.0.1:8787",
        MYAGENT_BEARER_TOKEN: "operator-token",
      },
      fetcher,
      write,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(write.mock.calls.map(([line]) => line)).toEqual([
      '{"type":"message.delta"}',
      '{"type":"run.failed"}',
    ]);
  });

  it("parses Problem Details when explicit connection options are rejected", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const harness = await startTestApp();
    try {
      await expect(executeCli([
        "agents",
        "list",
        "--api-url",
        "http://127.0.0.1:8787",
        "--token",
        "wrong-token",
      ], {
        environment: {},
        fetcher: injectFetcher(harness.app),
        write: vi.fn(),
      })).rejects.toMatchObject({
        status: 401,
        code: "unauthorized",
        detail: "Authentication is required.",
      });
    } finally {
      await harness.close();
    }
  });
});

function injectFetcher(app: FastifyInstance, beforeRequest?: (url: URL) => void): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    beforeRequest?.(url);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const injected = await app.inject({
      method: (init?.method ?? "GET") as never,
      url: `${url.pathname}${url.search}`,
      headers,
      ...(typeof init?.body === "string" ? { payload: init.body } : {}),
    });
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(injected.headers)) {
      if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : String(value));
    }
    return new Response(injected.statusCode === 204 ? null : injected.payload, {
      status: injected.statusCode,
      headers: responseHeaders,
    });
  }) as typeof fetch;
}

async function createRun(app: FastifyInstance, sessionKey: string, idempotencyKey: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/runs",
    headers: { authorization: "Bearer test-token", "idempotency-key": idempotencyKey },
    payload: { agentId: "primary", sessionKey, input: { type: "text", text: "seed" } },
  });
  expect(response.statusCode).toBe(202);
  return (response.json() as { runId: string }).runId;
}

function seedPendingApproval(db: DatabaseSync, runId: string, suffix: string): void {
  const now = "2026-08-07T00:00:00.000Z";
  db.prepare("UPDATE runs SET state = 'waiting_approval' WHERE run_id = ?").run(runId);
  db.prepare(`INSERT INTO tool_calls (
    tool_call_id, run_id, state, tool_name, effect, arguments_json,
    canonical_arguments, arguments_sha256, policy_effect, matched_rule,
    policy_facts_json, created_at, updated_at
  ) VALUES (?, ?, 'waiting_approval', 'run_command', 'side_effect', ?, ?, ?, 'ask', 0, '{}', ?, ?)`).run(
    `tool-cli-approval-${suffix}`,
    runId,
    '{"args":["hello"],"program":"node"}',
    '{"args":["hello"],"program":"node"}',
    `hash-cli-approval-${suffix}`,
    now,
    now,
  );
  db.prepare(`INSERT INTO approvals (
    approval_id, run_id, tool_call_id, state, arguments_sha256, expires_at, created_at
  ) VALUES (?, ?, ?, 'pending', ?, ?, ?)`).run(
    `approval-cli-${suffix}`,
    runId,
    `tool-cli-approval-${suffix}`,
    `hash-cli-approval-${suffix}`,
    "2026-08-08T00:00:00.000Z",
    now,
  );
}

function seedUnknownToolCall(db: DatabaseSync, runId: string, suffix: string): void {
  const now = "2026-08-07T00:00:00.000Z";
  db.prepare("UPDATE runs SET state = 'waiting_reconciliation' WHERE run_id = ?").run(runId);
  db.prepare(`INSERT INTO tool_calls (
    tool_call_id, run_id, state, tool_name, effect, arguments_json,
    canonical_arguments, arguments_sha256, policy_effect, matched_rule,
    policy_facts_json, created_at, updated_at
  ) VALUES (?, ?, 'unknown', 'write_file', 'side_effect', ?, ?, ?, 'allow', 0, '{}', ?, ?)`).run(
    `tool-cli-${suffix}`,
    runId,
    '{"content":"x","path":"report.txt"}',
    '{"content":"x","path":"report.txt"}',
    `hash-cli-${suffix}`,
    now,
    now,
  );
}
