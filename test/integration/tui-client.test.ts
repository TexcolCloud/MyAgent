import { describe, expect, it } from "vitest";

import { CliHttpError } from "../../src/interfaces/cli/client.js";
import { TuiClient } from "../../src/interfaces/tui/tui-client.js";

describe("TuiClient", () => {
  it("forwards Run creation cancellation to fetch", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    const client = new TuiClient({
      runToken: "run",
      adminToken: "admin",
      fetcher: async (_input, init) => {
        receivedSignal = init?.signal;
        return Response.json({
          runId: "run_1",
          status: "queued",
          eventsUrl: "/v1/runs/run_1/events",
        }, { status: 202 });
      },
    });

    await client.createRun({
      agentId: "primary",
      sessionKey: "terminal",
      text: "hello",
      signal: controller.signal,
    });

    expect(receivedSignal).toBe(controller.signal);
  });

  it("refuses an ordinary request redirect without exposing its target", async () => {
    const redirectTarget = "https://unconfirmed.example/v1/agents?token=must-not-appear";
    let redirectPolicy: RequestInit["redirect"];
    const client = new TuiClient({
      runToken: "run",
      adminToken: "admin",
      fetcher: async (_input, init) => {
        redirectPolicy = init?.redirect;
        return new Response(null, {
          status: 302,
          headers: { location: redirectTarget },
        });
      },
    });

    const failure = await client.listAgents().catch((error: unknown) => error);

    expect(redirectPolicy).toBe("manual");
    expect(failure).toBeInstanceOf(CliHttpError);
    expect(failure).toMatchObject({
      status: 302,
      code: "redirect_refused",
      detail: "The service response attempted a redirect.",
      traceId: "cli",
    });
    expect(String(failure)).not.toContain(redirectTarget);
    expect(String(failure)).not.toContain("must-not-appear");
  });

  it("refuses an SSE redirect without exposing its target", async () => {
    const redirectTarget = "https://unconfirmed.example/events?token=must-not-appear";
    let redirectPolicy: RequestInit["redirect"];
    const client = new TuiClient({
      runToken: "run",
      adminToken: "admin",
      fetcher: async (_input, init) => {
        redirectPolicy = init?.redirect;
        return new Response(null, {
          status: 307,
          headers: { location: redirectTarget },
        });
      },
    });

    const failure = await client.stream("/v1/runs/run_1/events").catch((error: unknown) => error);

    expect(redirectPolicy).toBe("manual");
    expect(failure).toBeInstanceOf(CliHttpError);
    expect(failure).toMatchObject({
      status: 307,
      code: "redirect_refused",
      detail: "The service response attempted a redirect.",
      traceId: "cli",
    });
    expect(String(failure)).not.toContain(redirectTarget);
    expect(String(failure)).not.toContain("must-not-appear");
  });

  it("rejects a shared Run and Admin token before making requests", () => {
    expect(() => new TuiClient({ runToken: "shared", adminToken: "shared" }))
      .toThrow(expect.objectContaining({ code: "tui_tokens_must_differ" }));
  });

  it("keeps Run and Admin authority on their exact endpoints", async () => {
    const requests: { url: string; authorization: string | null; redirect?: RequestInit["redirect"]; body?: unknown }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        ...(init?.redirect === undefined ? {} : { redirect: init.redirect }),
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
    await client.adminRequest("/v1/admin/model-profiles", {
      method: "POST",
      body: { catalogCandidateId: "pi/deepseek:deepseek-chat" },
    });

    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:8787/v1/runs",
        authorization: "Bearer run",
        redirect: "manual",
        body: { agentId: "primary", sessionKey: "terminal", input: { type: "text", text: "hello" } },
      },
      { url: "http://127.0.0.1:8787/v1/runs/run_1", authorization: "Bearer run", redirect: "manual" },
      {
        url: "http://127.0.0.1:8787/v1/approvals/approval%2F1/decision",
        authorization: "Bearer run",
        redirect: "manual",
        body: { decision: "approve" },
      },
      { url: "http://127.0.0.1:8787/v1/approvals?status=pending", authorization: "Bearer run", redirect: "manual" },
      { url: "http://127.0.0.1:8787/v1/admin/provider-drivers", authorization: "Bearer admin", redirect: "manual" },
      {
        url: "http://127.0.0.1:8787/v1/admin/model-profiles",
        authorization: "Bearer admin",
        redirect: "manual",
        body: { catalogCandidateId: "pi/deepseek:deepseek-chat" },
      },
    ]);
  });
});
