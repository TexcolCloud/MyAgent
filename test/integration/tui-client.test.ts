import { describe, expect, it } from "vitest";

import { TuiClient } from "../../src/interfaces/tui/tui-client.js";

describe("TuiClient", () => {
  it("rejects a shared Run and Admin token before making requests", () => {
    expect(() => new TuiClient({ runToken: "shared", adminToken: "shared" }))
      .toThrow(expect.objectContaining({ code: "tui_tokens_must_differ" }));
  });

  it("keeps Run and Admin authority on their exact endpoints", async () => {
    const requests: { url: string; authorization: string | null; body?: unknown }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
      });
      const path = new URL(String(input)).pathname;
      if (path === "/v1/runs") {
        return Response.json({ runId: "run_1", status: "queued", eventsUrl: "/v1/runs/run_1/events" }, { status: 202 });
      }
      if (path === "/v1/runs/run_1") {
        return Response.json({ runId: "run_1", status: "queued" });
      }
      if (path === "/v1/approvals/approval%2F1/decision") {
        return Response.json({ approvalId: "approval/1", runId: "run_1", state: "approved", resolvedAt: "2026-08-12T00:00:00.000Z" });
      }
      if (path === "/v1/approvals") {
        return Response.json({ approvals: [] });
      }
      return Response.json({ piVersion: "0.73.1", drivers: [] });
    };
    const client = new TuiClient({
      apiUrl: "http://127.0.0.1:8787/",
      runToken: "run",
      adminToken: "admin",
      fetcher,
    });

    await expect(client.createRun({ agentId: "primary", sessionKey: "terminal", text: "hello" }))
      .resolves.toEqual({ runId: "run_1", status: "queued", eventsUrl: "/v1/runs/run_1/events" });
    await client.getRun("run_1");
    await client.decideApproval("approval/1", "approve");
    await client.listPendingApprovals();
    await client.listProviderDrivers();

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:8787/v1/runs",
        authorization: "Bearer run",
        body: { agentId: "primary", sessionKey: "terminal", input: { type: "text", text: "hello" } },
      },
      { url: "http://127.0.0.1:8787/v1/runs/run_1", authorization: "Bearer run" },
      {
        url: "http://127.0.0.1:8787/v1/approvals/approval%2F1/decision",
        authorization: "Bearer run",
        body: { decision: "approve" },
      },
      { url: "http://127.0.0.1:8787/v1/approvals?status=pending", authorization: "Bearer run" },
      { url: "http://127.0.0.1:8787/v1/admin/provider-drivers", authorization: "Bearer admin" },
    ]);
  });
});
