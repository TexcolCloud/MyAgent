import { describe, expect, it } from "vitest";

import { CliHttpError } from "../../src/interfaces/cli/client.js";
import {
  TuiClient,
  TuiResponseValidationError,
  TuiRevisionConflictError,
} from "../../src/interfaces/tui/tui-client.js";

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

  it("does not expose a generic Admin request escape hatch", () => {
    const client = new TuiClient({ runToken: "run", adminToken: "admin" });
    // @ts-expect-error TUI callers must use named, schema-checked capabilities.
    void client.adminRequest;
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
        return Response.json({
          runId: "run_1",
          sessionId: "session_1",
          agentId: "primary",
          status: "queued",
          fifoSequence: 1,
          parentRunId: null,
          rootRunId: "run_1",
          delegationDepth: 0,
          budget: {
            modelTurns: 0,
            toolCalls: 0,
            childRuns: 0,
            delegationDepth: 0,
            activeExecutionSeconds: 0,
            toolOutputBytes: 0,
          },
          createdAt: "2026-08-13T00:00:00.000Z",
          updatedAt: "2026-08-13T00:00:00.000Z",
        });
      }
      if (path === "/v1/approvals/approval%2F1/decision") {
        return Response.json({ approvalId: "approval/1", runId: "run_1", state: "approved", resolvedAt: "2026-08-12T00:00:00.000Z" });
      }
      if (path === "/v1/approvals") {
        return Response.json({ approvals: [] });
      }
      if (path === "/v1/admin/model-profiles") {
        return Response.json({ profiles: [] });
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
    await client.listModelProfiles();

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
      { url: "http://127.0.0.1:8787/v1/admin/model-profiles", authorization: "Bearer admin", redirect: "manual" },
    ]);
  });

  it("uses explicit Admin resource methods for existing Provider workflows", async () => {
    const requests = captureRequests();
    const client = new TuiClient({
      runToken: "run",
      adminToken: "admin",
      fetcher: requests.fetcher,
    });

    await client.listProviderConnections();
    await client.getProviderConnection("deep/seek");
    await client.createProvider({
      slug: "deepseek",
      displayName: "DeepSeek",
      kind: "deepseek",
      auth: { type: "api_key" },
      apiKey: "write-only",
    });
    await client.reviseProvider("deep/seek", {
      expectedRevision: 2,
      displayName: "DeepSeek v2",
      baseUrl: "https://api.deepseek.com/v2",
      auth: { type: "managed_secret", secretVersionId: "msv_2" },
      allowInsecureHttp: false,
      protocolPreference: "responses",
    });
    await client.promoteProvider("deep/seek", {
      connectionRevisionId: "pcr_2",
      expectedRevision: 3,
    });
    await client.retireProvider("deep/seek", { expectedRevision: 4 });
    await client.purgeProvider("deep/seek", { expectedRevision: 5, confirm: true });
    await client.discoverProviderModels("pcr/2", { expectedRevision: 6 });
    await client.getProviderModels("pcr/2");

    expect(requests.values).toEqual([
      request("/v1/admin/provider-connections"),
      request("/v1/admin/provider-connections/deep%2Fseek"),
      request("/v1/admin/provider-connections", "POST", {
        slug: "deepseek",
        displayName: "DeepSeek",
        kind: "deepseek",
        auth: { type: "api_key" },
        apiKey: "write-only",
      }),
      request("/v1/admin/provider-connections/deep%2Fseek/revisions", "POST", {
        expectedRevision: 2,
        displayName: "DeepSeek v2",
        baseUrl: "https://api.deepseek.com/v2",
        auth: { type: "managed_secret", secretVersionId: "msv_2" },
        allowInsecureHttp: false,
        protocolPreference: "responses",
      }),
      request("/v1/admin/provider-connections/deep%2Fseek/promotions", "POST", {
        connectionRevisionId: "pcr_2",
        expectedRevision: 3,
      }),
      request("/v1/admin/provider-connections/deep%2Fseek/retirement", "POST", {
        expectedRevision: 4,
      }),
      request("/v1/admin/provider-connections/deep%2Fseek/purge", "POST", {
        expectedRevision: 5,
        confirm: true,
      }),
      request("/v1/admin/provider-connection-revisions/pcr%2F2/discover", "POST", {
        expectedRevision: 6,
      }),
      request("/v1/admin/provider-connection-revisions/pcr%2F2/models"),
    ]);
  });

  it("uses explicit Admin resource methods for existing Model workflows", async () => {
    const requests = captureRequests();
    const client = new TuiClient({
      runToken: "run",
      adminToken: "admin",
      fetcher: requests.fetcher,
    });

    await client.listModelProfiles();
    await client.getModelProfile("model/one");
    await client.createModelProfile({
      slug: "model-one",
      displayName: "Model One",
      connectionRevisionId: "pcr_1",
      catalogCandidateId: "pi/deepseek:deepseek-chat",
    });
    await client.promoteModelProfile("model/one", {
      profileRevisionId: "mpr_2",
      expectedRevision: 7,
    });
    await client.retireModelProfile("model/one", { expectedRevision: 8 });
    await client.purgeModelProfile("model/one", { expectedRevision: 9, confirm: true });
    await client.verifyModel("mpr/2", {
      expectedRevision: 10,
      capabilityBaseline: "text_and_single_tool_call_v1",
    });
    await client.getModelVerification("ver/2");
    await client.cancelModelVerification("ver/2", { expectedRevision: 11 });
    await client.getModelAssignment("agent/one");
    await client.assignModel("agent/one", {
      modelProfileRevisionId: "mpr_2",
      expectedRevision: 12,
    });
    await client.getDefaultModelProfile();
    await client.setDefaultModelProfile({ profileId: "model-one", expectedRevision: 13 });
    await client.destroyManagedSecretVersion("msv/2", { expectedRevision: 14, confirm: true });
    await client.rotateManagedSecretsMasterKey({ expectedRevision: 15 });

    expect(requests.values).toEqual([
      request("/v1/admin/model-profiles"),
      request("/v1/admin/model-profiles/model%2Fone"),
      request("/v1/admin/model-profiles", "POST", {
        slug: "model-one",
        displayName: "Model One",
        connectionRevisionId: "pcr_1",
        catalogCandidateId: "pi/deepseek:deepseek-chat",
      }),
      request("/v1/admin/model-profiles/model%2Fone/promotions", "POST", {
        profileRevisionId: "mpr_2",
        expectedRevision: 7,
      }),
      request("/v1/admin/model-profiles/model%2Fone/retirement", "POST", {
        expectedRevision: 8,
      }),
      request("/v1/admin/model-profiles/model%2Fone/purge", "POST", {
        expectedRevision: 9,
        confirm: true,
      }),
      request("/v1/admin/model-profile-revisions/mpr%2F2/verifications", "POST", {
        expectedRevision: 10,
        capabilityBaseline: "text_and_single_tool_call_v1",
      }),
      request("/v1/admin/model-verifications/ver%2F2"),
      request("/v1/admin/model-verifications/ver%2F2/cancel", "POST", {
        expectedRevision: 11,
      }),
      request("/v1/admin/agents/agent%2Fone/model-assignment"),
      request("/v1/admin/agents/agent%2Fone/model-assignment", "PUT", {
        modelProfileRevisionId: "mpr_2",
        expectedRevision: 12,
      }),
      request("/v1/admin/default-model-profile"),
      request("/v1/admin/default-model-profile", "PUT", {
        profileId: "model-one",
        expectedRevision: 13,
      }),
      request("/v1/admin/managed-secret-versions/msv%2F2/destruction", "POST", {
        expectedRevision: 14,
        confirm: true,
      }),
      request("/v1/admin/managed-secrets/master-key-rotation", "POST", {
        expectedRevision: 15,
      }),
    ]);
  });

  it("normalizes revision conflicts to reload-required without silently retrying", async () => {
    let requestCount = 0;
    const client = new TuiClient({
      runToken: "run",
      adminToken: "admin",
      fetcher: async () => {
        requestCount += 1;
        return Response.json({
          code: "revision_conflict",
          detail: "The resource revision changed.",
          traceId: "trace-conflict",
          apiKey: "must-not-project",
        }, { status: 409 });
      },
    });

    const failure = await client.promoteProvider("deepseek", {
      connectionRevisionId: "pcr_2",
      expectedRevision: 3,
    }).catch((error: unknown) => error);

    expect(requestCount).toBe(1);
    expect(failure).toBeInstanceOf(TuiRevisionConflictError);
    expect(failure).toMatchObject({
      status: 409,
      code: "revision_conflict",
      detail: "The resource revision changed.",
      traceId: "trace-conflict",
      reloadRequired: true,
    });
    expect(failure).not.toHaveProperty("apiKey");
    expect(String(failure)).not.toContain("must-not-project");
  });

  it.each([
    ["apiKey", "secret-api-key"],
    ["value", "secret-value"],
    ["fromEnvironment", "SECRET_ENVIRONMENT_NAME"],
    ["rawProvider", { authorization: "Bearer secret-provider-token" }],
  ])("rejects successful Provider responses containing unsafe field %s", async (field, value) => {
    const client = new TuiClient({
      runToken: "run",
      adminToken: "admin",
      fetcher: async () => Response.json({
        connections: [{
          connectionId: "deepseek",
          displayName: "DeepSeek",
          providerKind: "deepseek",
          activeRevisionId: null,
          retiredAt: null,
          recordRevision: 0,
          credentialConfigured: false,
          revisions: [],
          [field]: value,
        }],
      }),
    });

    const failure = await client.listProviderConnections().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TuiResponseValidationError);
    expect(failure).toMatchObject({
      code: "invalid_tui_response",
      detail: "The service returned an invalid response.",
      traceId: "tui",
    });
    expect(String(failure)).not.toContain(String(value));
    expect(failure).not.toHaveProperty("cause");
  });

  it("rejects a malformed successful detail response with a fixed safe error", async () => {
    const rawBody = "raw-provider-secret";
    const client = new TuiClient({
      runToken: "run",
      adminToken: "admin",
      fetcher: async () => Response.json({
        connectionId: "deepseek",
        rawProvider: rawBody,
      }),
    });

    const failure = await client.getProviderConnection("deepseek")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TuiResponseValidationError);
    expect(String(failure)).toBe("TuiResponseValidationError: invalid_tui_response");
    expect(JSON.stringify(failure)).not.toContain(rawBody);
  });
});

interface CapturedRequest {
  readonly path: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body?: unknown;
}

function captureRequests(): { readonly values: CapturedRequest[]; readonly fetcher: typeof fetch } {
  const values: CapturedRequest[] = [];
  return {
    values,
    fetcher: async (input, init) => {
      values.push({
        path: `${new URL(String(input)).pathname}${new URL(String(input)).search}`,
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization"),
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
      });
      return responseFor(new URL(String(input)).pathname, init?.method ?? "GET");
    },
  };
}

function responseFor(path: string, method: string): Response {
  const connection = {
    connectionId: "deepseek",
    displayName: "DeepSeek",
    providerKind: "deepseek",
    activeRevisionId: null,
    retiredAt: null,
    recordRevision: 0,
    credentialConfigured: false,
    revisions: [],
  };
  const profile = {
    profileId: "model-one",
    displayName: "Model One",
    activeRevisionId: null,
    retiredAt: null,
    recordRevision: 0,
    revisions: [],
  };
  if (path === "/v1/admin/provider-connections" && method === "GET") {
    return Response.json({ connections: [connection] });
  }
  if (path.endsWith("/purge")) return new Response(null, { status: 204 });
  if (path.startsWith("/v1/admin/provider-connections/")) return Response.json(connection);
  if (path === "/v1/admin/provider-connections") return Response.json(connection);
  if (path.includes("/provider-connection-revisions/")) {
    return Response.json({
      connectionRevisionId: "pcr_2",
      recordRevision: 1,
      state: "fresh",
      models: [],
      cache: { fetchedAt: null, expiresAt: null },
      error: null,
    });
  }
  if (path === "/v1/admin/model-profiles" && method === "GET") {
    return Response.json({ profiles: [profile] });
  }
  if (path.startsWith("/v1/admin/model-profiles/")) return Response.json(profile);
  if (path === "/v1/admin/model-profiles") return Response.json(profile);
  if (path.includes("/model-profile-revisions/")) {
    return Response.json({
      verificationId: "ver_2",
      profileRevisionId: "mpr_2",
      capabilityBaseline: "text_and_single_tool_call_v1",
      status: "queued",
      recordRevision: 1,
      operationUrl: "/v1/admin/model-verifications/ver_2",
    }, { status: 202 });
  }
  if (path.includes("/model-verifications/")) {
    return Response.json({
      verificationId: "ver_2",
      profileRevisionId: "mpr_2",
      capabilityBaseline: "text_and_single_tool_call_v1",
      status: "cancelled",
      resultCode: null,
      safeStatus: null,
      capabilities: [],
      traceId: "trace_2",
      recordRevision: 1,
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
      cancellationRequestedAt: "2026-08-13T00:00:00.000Z",
      fallbackProfileRevisionId: null,
      fallbackVerificationId: null,
    });
  }
  if (path.includes("/model-assignment")) {
    return Response.json({
      agentId: "agent-one",
      state: "unassigned",
      modelProfileRevisionId: null,
      source: null,
      recordRevision: null,
      updatedAt: null,
    });
  }
  if (path === "/v1/admin/default-model-profile") {
    return Response.json({ state: "unset", profileId: null, recordRevision: null });
  }
  if (path.endsWith("/destruction")) return new Response(null, { status: 204 });
  if (path.endsWith("/master-key-rotation")) {
    return Response.json({ reencrypted: 1, currentKeyId: "key_2", recordRevision: 1 });
  }
  return Response.json({});
}

function request(path: string, method = "GET", body?: unknown): CapturedRequest {
  return {
    path,
    method,
    authorization: "Bearer admin",
    ...(body === undefined ? {} : { body }),
  };
}
