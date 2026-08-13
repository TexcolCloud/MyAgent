import { describe, expect, it } from "vitest";

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
    await client.listSessions({ agentId: "primary", limit: 25 });

    expect(paths).toEqual([
      "/v1/runs?agentId=primary&sessionKey=session%3Ahistory&limit=25",
      "/v1/sessions?agentId=primary&limit=25",
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
});
