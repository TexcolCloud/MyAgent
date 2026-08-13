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
