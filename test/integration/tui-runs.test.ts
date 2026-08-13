import { describe, expect, it, vi } from "vitest";

import { CliHttpError } from "../../src/interfaces/cli/client.js";
import { InspectorScreen } from "../../src/interfaces/tui/screens/inspector.js";
import { RunsScreen } from "../../src/interfaces/tui/screens/runs.js";
import { TuiClient } from "../../src/interfaces/tui/tui-client.js";

describe("TUI Run history transport", () => {
  it("uses typed Run and Session history endpoints without local persistence access", async () => {
    const paths: string[] = [];
    const client = new TuiClient({
      runToken: "run",
      adminToken: "admin",
      fetcher: async (input) => {
        const url = new URL(String(input));
        paths.push(`${url.pathname}${url.search}`);
        if (url.pathname === "/v1/runs") return Response.json({ items: [] });
        return Response.json({ items: [] });
      },
    });

    await client.listRunHistory({ agentId: "primary", sessionKey: "session:history", limit: 25 });
    await client.listSessions({ agentId: "primary", sessionKey: "session:history", limit: 25 });

    expect(paths).toEqual([
      "/v1/runs?agentId=primary&sessionKey=session%3Ahistory&limit=25",
      "/v1/sessions?agentId=primary&sessionKey=session%3Ahistory&limit=25",
    ]);
  });

  it("makes combined Session filters unambiguously request paginated history by default", async () => {
    const paths: string[] = [];
    const client = new TuiClient({
      runToken: "run",
      adminToken: "admin",
      fetcher: async (input) => {
        paths.push(`${new URL(String(input)).pathname}${new URL(String(input)).search}`);
        return Response.json({ items: [] });
      },
    });

    await client.listSessions({ agentId: "primary", sessionKey: "session:history" });

    expect(paths).toEqual(["/v1/sessions?agentId=primary&sessionKey=session%3Ahistory&limit=50"]);
  });

  it("keeps Session history review-only so durable Runs are never deleted from the TUI", async () => {
    let deleteRequests = 0;
    const client = new TuiClient({
      runToken: "run", adminToken: "admin",
      fetcher: async (input, init) => {
        if ((init?.method ?? "GET") === "DELETE") deleteRequests += 1;
        if (new URL(String(input)).pathname === "/v1/sessions") return Response.json({ items: [{ sessionId: "ses_1", agentId: "primary", sessionKey: "session:history", createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z" }] });
        return Response.json({ items: [{ runId: "run_1" }] });
      },
    });

    await client.listSessions();
    expect(deleteRequests).toBe(0);
  });

  it("rejects noncanonical opaque history cursors before issuing a query", async () => {
    const client = new TuiClient({ runToken: "run", adminToken: "admin", fetcher: async () => Response.json({}) });
    await expect(client.listRunHistory({ agentId: "primary", sessionKey: "session:history", cursor: "not-a-cursor" })).rejects.toMatchObject({ code: "invalid_tui_response" });
  });

  it("selects a Run detail, confirms cancellation with its revision, and refreshes the result", async () => {
    const initial = run("run_1", "running", "2026-08-13T00:00:00.000Z");
    const cancelled = run("run_1", "cancelled", "2026-08-13T00:00:01.000Z");
    const getRun = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(initial).mockResolvedValueOnce(cancelled);
    const cancelRun = vi.fn(async () => cancelled);
    const screen = new RunsScreen({
      client: { listRunHistory: vi.fn(async () => ({ items: [initial] })), getRun, cancelRun },
      inspector: new InspectorScreen(),
      promptFactory: () => ({ input: async () => "", confirm: async () => true } as never),
    });

    await screen.loadFor("researcher", "session:review");
    screen.handleInput("\r");
    await screen.settled();
    screen.handleInput("x");
    await screen.settled();

    expect(getRun).toHaveBeenCalledTimes(3);
    expect(cancelRun).toHaveBeenCalledExactlyOnceWith("run_1", "2026-08-13T00:00:00.000Z");
    expect(screen.render(120).join("\n")).toContain("cancelled");
  });

  it("renders a selected terminal Run result without exposing secret-bearing fields", async () => {
    const completed = {
      ...run("run_1", "cancelled", "2026-08-13T00:00:00.000Z"),
      status: "completed" as const,
      result: { type: "text", text: "durable result\nAuthorization: Bearer secret-value" },
    };
    const screen = new RunsScreen({
      client: { listRunHistory: vi.fn(async () => ({ items: [completed] })), getRun: vi.fn(async () => completed), cancelRun: vi.fn() },
      inspector: new InspectorScreen(),
      promptFactory: () => ({ input: async () => "", confirm: async () => true } as never),
    });

    await screen.loadFor("researcher", "session:review");
    screen.handleInput("\r");
    await screen.settled();

    const frame = screen.render(120).join("\n");
    expect(frame).toContain("durable result");
    expect(frame).not.toContain("secret-value");
  });

  it("renders typed failure and nonterminal Run details safely", async () => {
    const failed = { ...run("run_failed", "cancelled", "2026-08-13T00:00:00.000Z"), status: "failed" as const, failure: { code: "provider_unavailable" } };
    const active = { ...run("run_active", "running", "2026-08-13T00:00:01.000Z") };
    const getRun = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(active);
    const screen = new RunsScreen({
      client: { listRunHistory: vi.fn(async () => ({ items: [failed, active] })), getRun, cancelRun: vi.fn() },
      inspector: new InspectorScreen(),
      promptFactory: () => ({ input: async () => "", confirm: async () => true } as never),
    });

    await screen.loadFor("researcher", "session:review");
    screen.handleInput("\r");
    await screen.settled();
    expect(screen.render(120).join("\n")).toContain("Failure: provider_unavailable");
    screen.handleInput("\u001b[B");
    screen.handleInput("\r");
    await screen.settled();
    expect(screen.render(120).join("\n")).toContain("Run is not terminal.");
  });

  it("locks Run controls after a revision conflict and does not retry cancellation", async () => {
    const initial = run("run_1", "running", "2026-08-13T00:00:00.000Z");
    const cancelRun = vi.fn(async () => { throw new CliHttpError(409, "revision_conflict", "changed", "trace"); });
    const screen = new RunsScreen({
      client: { listRunHistory: vi.fn(async () => ({ items: [initial] })), getRun: vi.fn(async () => initial), cancelRun },
      inspector: new InspectorScreen(),
      promptFactory: () => ({ input: async () => "", confirm: async () => true } as never),
    });

    await screen.loadFor("researcher", "session:review");
    screen.handleInput("x");
    await screen.settled();
    screen.handleInput("x");

    expect(cancelRun).toHaveBeenCalledOnce();
    expect(screen.render(120).join("\n")).toContain("Reload required");
  });
});

function run(runId: string, status: "running" | "cancelled", updatedAt: string) {
  return { runId, sessionId: "ses_1", agentId: "researcher", status, fifoSequence: 0, parentRunId: null, rootRunId: runId, delegationDepth: 0, budget: { modelTurns: 0, toolCalls: 0, childRuns: 0, delegationDepth: 0, activeExecutionSeconds: 0, toolOutputBytes: 0 }, createdAt: "2026-08-13T00:00:00.000Z", updatedAt };
}
