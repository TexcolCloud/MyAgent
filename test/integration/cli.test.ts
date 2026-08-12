import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";

import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";

import { startTestApp } from "../helpers/start-test-app.js";
import { tempPath } from "../helpers/temp-dir.js";

describe("CLI HTTP boundary", () => {
  it("returns one Problem and does not invoke the TUI boundary without an interactive terminal", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const output: string[] = [];
    const runTui = vi.fn();

    await expect(executeCli(["tui"], {
      stdinIsTTY: false,
      stdoutIsTTY: false,
      runTui,
      write: (line) => output.push(line),
      writeError: (line) => output.push(line),
    })).resolves.toBe(2);

    expect(output).toEqual([
      "interactive_tty_required: An interactive TTY is required. (traceId: cli)",
    ]);
    expect(runTui).not.toHaveBeenCalled();
  });

  it("validates TUI flags before acquiring the terminal and keeps configured tokens out of output", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const output: string[] = [];
    const environment = {
      MYAGENT_RUN_TOKEN: "run-token-must-not-appear",
      MYAGENT_ADMIN_TOKEN: "admin-token-must-not-appear",
    };
    const runTui = vi.fn();

    await expect(executeCli(["tui", "--unsupported", "value"], {
      environment,
      stdinIsTTY: false,
      stdoutIsTTY: false,
      write: (line) => output.push(line),
      writeError: (line) => output.push(line),
    })).resolves.toBe(2);
    await expect(executeCli(["tui", "--token", "override-run-token", "--admin-token", "override-admin-token"], {
      environment,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      runTui,
      write: (line) => output.push(line),
      writeError: (line) => output.push(line),
    })).resolves.toBe(0);

    expect(output).toEqual([
      "invalid_cli_command: The CLI command is invalid. (traceId: cli)",
    ]);
    expect(runTui).toHaveBeenCalledOnce();
    expect(output.join("\n")).not.toContain("token");
  });

  it("uses explicit TUI token overrides for their separate authority clients", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const authorizations: string[] = [];
    const runTui = async (input: { readonly client: { listProviderDrivers(): Promise<unknown> } }) => {
      await input.client.listProviderDrivers();
    };

    await expect(executeCli(["tui", "--token", "run-override", "--admin-token", "admin-override"], {
      environment: { MYAGENT_RUN_TOKEN: "run-environment", MYAGENT_ADMIN_TOKEN: "admin-environment" },
      stdinIsTTY: true,
      stdoutIsTTY: true,
      fetcher: async (_input, init) => {
        authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
        return Response.json({ piVersion: "0.73.1", drivers: [] });
      },
      runTui: runTui as never,
      writeError: () => undefined,
    })).resolves.toBe(0);

    expect(authorizations).toEqual(["Bearer admin-override"]);
  });

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
    const completed = JSON.stringify({
      runId: "run-cli-1",
      sequence: 9,
      type: "run.completed",
      occurredAt: "2026-08-12T00:00:00.000Z",
      payload: { result: { type: "text", text: "done" } },
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(
        `id: 9\nevent: run.completed\ndata: ${completed}\n\n`,
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
    })).resolves.toBe(0);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(completed);
  });

  it("preserves validated noncanonical SSE data when watching a Run", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const completed = [
      "{",
      ' "type" : "run.completed", "payload" : {},',
      ' "occurredAt" : "2026-08-12T00:00:00.000Z", "sequence" : 9, "runId" : "run-cli-1"',
      "}",
    ].join("\n");
    const data = completed.split("\n").map((line) => `data: ${line}`).join("\n");
    const write = vi.fn();

    await expect(executeCli(["run", "watch", "run-cli-1"], {
      environment: {
        MYAGENT_API_URL: "http://127.0.0.1:8787",
        MYAGENT_BEARER_TOKEN: "operator-token",
      },
      fetcher: async () => new Response(
        `id: 9\nevent: run.completed\n${data}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
      write,
    })).resolves.toBe(0);

    expect(write).toHaveBeenCalledWith(completed);
  });

  it("fails a Run watch with the existing credential exit when its token is absent", async () => {
    const { CliClient } = await import("../../src/interfaces/cli/client.js");
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const originalStream = CliClient.prototype.stream;
    let attempts = 0;
    const stream = vi.spyOn(CliClient.prototype, "stream").mockImplementation(function (this: InstanceType<typeof CliClient>, ...args) {
      attempts += 1;
      if (attempts === 1) return originalStream.apply(this, args);
      return Promise.resolve(new Response(
        "id: 1\nevent: run.completed\ndata: {\"runId\":\"run-cli-1\",\"sequence\":1,\"type\":\"run.completed\",\"occurredAt\":\"2026-08-12T00:00:00.000Z\",\"payload\":{}}\n\n",
        { status: 200 },
      ));
    });
    try {
      await expect(executeCli(["run", "watch", "run-cli-1"], {
        environment: { MYAGENT_API_URL: "http://127.0.0.1:8787" },
        writeError: () => undefined,
      })).resolves.toBe(3);
      expect(stream).toHaveBeenCalledOnce();
    } finally {
      stream.mockRestore();
    }
  });

  it("fails a Run watch with the existing service exit after one fetch rejection", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValue(new Response(
        "id: 1\nevent: run.completed\ndata: {\"runId\":\"run-cli-1\",\"sequence\":1,\"type\":\"run.completed\",\"occurredAt\":\"2026-08-12T00:00:00.000Z\",\"payload\":{}}\n\n",
        { status: 200 },
      ));

    await expect(executeCli(["run", "watch", "run-cli-1"], {
      environment: {
        MYAGENT_API_URL: "http://127.0.0.1:8787",
        MYAGENT_BEARER_TOKEN: "operator-token",
      },
      fetcher,
      writeError: () => undefined,
    })).resolves.toBe(6);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("returns after a non-terminal stream EOF without reconnecting", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const delta = JSON.stringify({
      runId: "run-cli-1",
      sequence: 4,
      type: "message.delta",
      occurredAt: "2026-08-12T00:00:00.000Z",
      payload: { text: "hello" },
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(
        `id: 4\nevent: message.delta\ndata: ${delta}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ))
      .mockRejectedValue(new Error("unexpected_eof_reconnect"));
    const write = vi.fn();

    await expect(executeCli(["run", "watch", "run-cli-1"], {
      environment: {
        MYAGENT_API_URL: "http://127.0.0.1:8787",
        MYAGENT_BEARER_TOKEN: "operator-token",
      },
      fetcher,
      write,
    })).resolves.toBe(0);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(delta);
  });

  it("parses Problem Details when explicit connection options are rejected", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const harness = await startTestApp();
    const output: string[] = [];
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
        write: (line) => output.push(line),
        writeError: (line) => output.push(line),
      })).resolves.toBe(3);
      expect(output).toHaveLength(1);
      expect(output[0]).toMatch(/^unauthorized: Authentication is required\. \(traceId: .+\)$/u);
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
