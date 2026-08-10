import { describe, expect, it, vi } from "vitest";

import { executeCli, type CliPrompt } from "../../src/interfaces/cli/main.js";

const environment = {
  MYAGENT_API_URL: "http://127.0.0.1:8787",
  MYAGENT_BEARER_TOKEN: "run-token",
  MYAGENT_ADMIN_TOKEN: "admin-token",
};

describe("model control CLI", () => {
  it.each([
    [["providers", "add", "--slug", "deepseek", "--display-name", "DeepSeek", "--kind", "deepseek", "--base-url", "https://api.deepseek.com", "--api-key-env", "DEEPSEEK_API_KEY", "--protocol", "responses"], "POST", "/v1/admin/provider-connections", { slug: "deepseek", displayName: "DeepSeek", kind: "deepseek", baseUrl: "https://api.deepseek.com", auth: { type: "environment", fromEnvironment: "DEEPSEEK_API_KEY" }, protocolPreference: "responses" }],
    [["providers", "update", "--provider", "deepseek", "--expected-revision", "1", "--display-name", "DeepSeek", "--base-url", "https://api.deepseek.com", "--api-key-env", "DEEPSEEK_API_KEY", "--protocol", "responses"], "POST", "/v1/admin/provider-connections/deepseek/revisions", { expectedRevision: 1, displayName: "DeepSeek", baseUrl: "https://api.deepseek.com", auth: { type: "environment", fromEnvironment: "DEEPSEEK_API_KEY" }, allowInsecureHttp: false, protocolPreference: "responses" }],
    [["providers", "list"], "GET", "/v1/admin/provider-connections", undefined],
    [["providers", "discover", "--connection-revision", "pcr_1", "--expected-revision", "2"], "POST", "/v1/admin/provider-connection-revisions/pcr_1/discover", { expectedRevision: 2 }],
    [["providers", "promote", "--provider", "deepseek", "--connection-revision", "pcr_1", "--expected-revision", "2"], "POST", "/v1/admin/provider-connections/deepseek/promotions", { connectionRevisionId: "pcr_1", expectedRevision: 2 }],
    [["providers", "retire", "--provider", "deepseek", "--expected-revision", "3"], "POST", "/v1/admin/provider-connections/deepseek/retirement", { expectedRevision: 3 }],
    [["models", "create", "--slug", "deepseek-flash", "--display-name", "DeepSeek Flash", "--connection-revision", "pcr_1", "--model-id", "deepseek-v4-flash", "--protocol", "responses", "--max-input-tokens", "65536", "--context-source", "operator"], "POST", "/v1/admin/model-profiles", { slug: "deepseek-flash", displayName: "DeepSeek Flash", connectionRevisionId: "pcr_1", modelId: "deepseek-v4-flash", protocol: "responses", maxInputTokens: 65536, contextWindowSource: "operator" }],
    [["models", "promote", "--model", "deepseek-flash", "--profile-revision", "mpr_1", "--expected-revision", "2"], "POST", "/v1/admin/model-profiles/deepseek-flash/promotions", { profileRevisionId: "mpr_1", expectedRevision: 2 }],
    [["models", "list"], "GET", "/v1/admin/model-profiles", undefined],
    [["models", "retire", "--model", "deepseek-flash", "--expected-revision", "3"], "POST", "/v1/admin/model-profiles/deepseek-flash/retirement", { expectedRevision: 3 }],
    [["models", "set-default", "--model", "deepseek-flash", "--expected-revision", "0"], "PUT", "/v1/admin/default-model-profile", { profileId: "deepseek-flash", expectedRevision: 0 }],
    [["agents", "set-model", "--agent", "primary", "--profile-revision", "mpr_1", "--expected-revision", "0"], "PUT", "/v1/admin/agents/primary/model-assignment", { modelProfileRevisionId: "mpr_1", expectedRevision: 0 }],
    [["verifications", "get", "--verification", "ver_1"], "GET", "/v1/admin/model-verifications/ver_1", undefined],
    [["secrets", "rotate-master-key", "--expected-revision", "4"], "POST", "/v1/admin/managed-secrets/master-key-rotation", { expectedRevision: 4 }],
  ] as const)("maps %j to the admin HTTP API", async (argumentsList, method, path, body) => {
    const calls: Array<{ method: string; path: string; body: unknown; authorization: string | null }> = [];
    const output: string[] = [];
    const fetcher = createFetcher((request) => {
      calls.push(request);
      return jsonResponse({ ok: true });
    });

    const exitCode = await executeCli([...argumentsList, "--json"], {
      environment,
      fetcher,
      write: (line) => output.push(line),
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([{ method, path, body, authorization: "Bearer admin-token" }]);
    expect(output).toEqual(['{"ok":true}']);
  });

  it("queues and polls model Verification to a terminal result", async () => {
    const paths: string[] = [];
    const output: string[] = [];
    const fetcher = createFetcher((request) => {
      paths.push(request.path);
      if (request.method === "POST") return jsonResponse({ verificationId: "ver_1", profileRevisionId: "mpr_1", capabilityBaseline: "text_and_single_tool_call_v1", status: "queued", recordRevision: 1, operationUrl: "/v1/admin/model-verifications/ver_1" }, 202);
      if (paths.length === 2) return jsonResponse(verification("running"));
      return jsonResponse(verification("passed"));
    });

    const exitCode = await executeCli(["models", "verify", "--profile-revision", "mpr_1", "--expected-revision", "0", "--json"], {
      environment,
      fetcher,
      sleep: async () => undefined,
      write: (line) => output.push(line),
    });

    expect(exitCode).toBe(0);
    expect(paths).toEqual([
      "/v1/admin/model-profile-revisions/mpr_1/verifications",
      "/v1/admin/model-verifications/ver_1",
      "/v1/admin/model-verifications/ver_1",
    ]);
    expect(JSON.parse(output[0]!)).toMatchObject({ status: "passed", traceId: "verification-trace" });
  });

  it.each([
    ["failed", 5, '{"code":"provider_auth_failed","detail":"Model verification failed.","traceId":"verification-trace"}'],
    ["cancelled", 0, undefined],
  ] as const)("maps terminal Verification %s to exit %i", async (status, expectedExit, expectedProblem) => {
    const output: string[] = [];
    const fetcher = createFetcher((request) => request.method === "POST"
      ? jsonResponse({ verificationId: "ver_1", profileRevisionId: "mpr_1", capabilityBaseline: "text_and_single_tool_call_v1", status: "queued", recordRevision: 1, operationUrl: "/v1/admin/model-verifications/ver_1" }, 202)
      : jsonResponse({ ...verification("passed"), status, resultCode: status === "failed" ? "provider_auth_failed" : null }));

    const exitCode = await executeCli(["models", "verify", "--profile-revision", "mpr_1", "--expected-revision", "0", "--json"], {
      environment,
      fetcher,
      write: (line) => output.push(line),
    });

    expect(exitCode).toBe(expectedExit);
    if (expectedProblem === undefined) expect(JSON.parse(output[0]!)).toMatchObject({ status: "cancelled" });
    else expect(output).toEqual([expectedProblem]);
  });

  it("maps a safe discovery failure response to provider exit 5", async () => {
    const output: string[] = [];
    const exitCode = await executeCli(["providers", "discover", "--connection-revision", "pcr_1", "--expected-revision", "1", "--json"], {
      environment,
      fetcher: createFetcher(() => jsonResponse({ connectionRevisionId: "pcr_1", recordRevision: 2, state: "failed", models: [], cache: { fetchedAt: "2026-08-10T00:00:00.000Z", expiresAt: null }, error: { code: "provider_unavailable", traceId: "discover-trace" } })),
      write: (line) => output.push(line),
    });

    expect(exitCode).toBe(5);
    expect(output).toEqual(['{"code":"provider_unavailable","detail":"Provider model discovery failed.","traceId":"discover-trace"}']);
  });

  it("maps a read terminal Verification failure to exit 5", async () => {
    const output: string[] = [];
    const exitCode = await executeCli(["verifications", "get", "--verification", "ver_1", "--json"], {
      environment,
      fetcher: createFetcher(() => jsonResponse({ ...verification("passed"), status: "failed", resultCode: "model_not_found" })),
      write: (line) => output.push(line),
    });

    expect(exitCode).toBe(5);
    expect(output).toEqual(['{"code":"model_not_found","detail":"Model verification failed.","traceId":"verification-trace"}']);
  });

  it("requires the Admin Token before fetch without exposing credentials", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const output: string[] = [];

    const exitCode = await executeCli(["providers", "list", "--json"], {
      environment: { MYAGENT_API_URL: environment.MYAGENT_API_URL, MYAGENT_BEARER_TOKEN: "do-not-use" },
      fetcher,
      write: (line) => output.push(line),
    });

    expect(exitCode).toBe(3);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output).toEqual(['{"code":"admin_token_required","detail":"Admin authentication is required.","traceId":"cli"}']);
    expect(output.join(" ")).not.toContain("do-not-use");
  });

  it("requires the Admin Token before starting interactive prompts", async () => {
    const fetcher = vi.fn<typeof fetch>();
    let selectCalled = false;
    const prompt: CliPrompt = {
      select: async <T extends string>(): Promise<T> => {
        selectCalled = true;
        throw new Error("unexpected_prompt");
      },
      input: vi.fn<CliPrompt["input"]>(),
      secret: vi.fn<CliPrompt["secret"]>(),
      confirm: vi.fn<CliPrompt["confirm"]>(),
    };

    const exitCode = await executeCli(["model", "setup", "--json"], {
      environment: { MYAGENT_API_URL: environment.MYAGENT_API_URL },
      fetcher,
      prompt,
      write: vi.fn(),
    });

    expect(exitCode).toBe(3);
    expect(selectCalled).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [["providers", "list", "unexpected"]],
    [["providers", "list", "--bogus", "value"]],
  ])("rejects arguments outside the approved command grammar: %j", async (argumentsList) => {
    const fetcher = vi.fn<typeof fetch>();
    const output: string[] = [];

    const exitCode = await executeCli([...argumentsList, "--json"], {
      environment,
      fetcher,
      write: (line) => output.push(line),
    });

    expect(exitCode).toBe(2);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output).toEqual(['{"code":"invalid_cli_command","detail":"The CLI command is invalid.","traceId":"cli"}']);
  });

  it.each([
    [400, "invalid_request", 2],
    [401, "unauthorized", 3],
    [403, "forbidden", 3],
    [409, "revision_conflict", 4],
    [422, "provider_auth_failed", 5],
    [503, "database_unavailable", 6],
  ])("maps HTTP %i Problem %s to exit %i and preserves traceId", async (status, code, expectedExit) => {
    const output: string[] = [];
    const exitCode = await executeCli(["providers", "list", "--json"], {
      environment,
      fetcher: createFetcher(() => jsonResponse({ code, detail: "safe detail", traceId: "trace-15" }, status)),
      write: (line) => output.push(line),
    });

    expect(exitCode).toBe(expectedExit);
    expect(output).toEqual([`{"code":"${code}","detail":"safe detail","traceId":"trace-15"}`]);
  });

  it("reads a managed API key only from stdin and never emits it", async () => {
    const plaintext = "stdin-super-secret";
    const output: string[] = [];
    let received = false;
    const fetcher = createFetcher((request) => {
      const body = request.body as { auth: { type: string }; apiKey?: string };
      received = body.auth.type === "api_key" && body.apiKey === plaintext;
      return jsonResponse({ connectionId: "custom" }, 201);
    });

    const exitCode = await executeCli(["providers", "add", "--slug", "custom", "--display-name", "Custom", "--kind", "openai_compatible", "--base-url", "https://models.example.test/v1", "--api-key-stdin", "--protocol", "chat_completions", "--json"], {
      environment,
      fetcher,
      readStdin: async () => plaintext,
      write: (line) => output.push(line),
    });

    expect(exitCode).toBe(0);
    expect(received).toBe(true);
    expect(output.join("\n")).not.toContain(plaintext);
  });

  it("reviews setup through HTTP and cancellation never promotes, defaults, or assigns", async () => {
    const requests: string[] = [];
    const output: string[] = [];
    const prompt = scriptedPrompt({
      selects: ["deepseek", "environment", "deepseek-v4-flash", "operator"],
      inputs: ["deepseek", "DeepSeek", "https://api.deepseek.com", "DEEPSEEK_API_KEY", "deepseek-flash", "DeepSeek Flash", "65536", "primary"],
      confirmations: [true, false, false],
    });
    const fetcher = setupFetcher(requests);

    const exitCode = await executeCli(["model", "setup"], {
      environment,
      fetcher,
      prompt,
      sleep: async () => undefined,
      write: (line) => output.push(line),
    });

    expect(exitCode).toBe(0);
    expect(requests).toContain("POST /v1/admin/provider-connections");
    expect(requests).toContain("POST /v1/admin/model-profile-revisions/mpr_1/verifications");
    expect(requests.some((request) => request.includes("promotions"))).toBe(false);
    expect(requests.some((request) => request.includes("default-model-profile"))).toBe(false);
    expect(requests.some((request) => request.startsWith("PUT ") && request.includes("model-assignment"))).toBe(false);
    expect(output.join("\n")).toContain("Destination: https://api.deepseek.com");
    expect(output.join("\n")).toContain("Auth: environment");
    expect(output.join("\n")).toContain("Model: deepseek-v4-flash");
    expect(output.join("\n")).toContain("Protocol: responses");
    expect(output.join("\n")).toContain("Capabilities: streaming_text, single_tool_call");
    expect(output.join("\n")).toContain("Usage: 3 input, 2 output");
    expect(output.join("\n")).toContain("Context source: operator");
    expect(output.join("\n")).toContain("Affected Agents: primary");
  });

  it("lets the control plane resolve a selected preset context limit", async () => {
    let profileBody: Record<string, unknown> | undefined;
    const prompt = scriptedPrompt({
      selects: ["deepseek", "environment", "deepseek-chat", "preset"],
      inputs: ["deepseek", "DeepSeek", "https://api.deepseek.com", "DEEPSEEK_API_KEY", "deepseek-chat", "DeepSeek Chat"],
      confirmations: [false],
    });
    const fetcher = createFetcher((request) => {
      if (request.path === "/v1/admin/model-profiles") {
        profileBody = request.body as Record<string, unknown>;
        return jsonResponse({ ...profileResponse(), revisions: [{ ...profileResponse().revisions[0], providerModelId: "deepseek-chat", maxInputTokens: 64000, contextWindowSource: "preset" }] }, 201);
      }
      if (request.path.endsWith("/discover")) return jsonResponse({ connectionRevisionId: "pcr_1", recordRevision: 1, state: "fresh", models: [{ id: "deepseek-chat" }], cache: { fetchedAt: "2026-08-10T00:00:00.000Z", expiresAt: "2026-08-10T01:00:00.000Z" }, error: null });
      return setupResponse(request);
    });

    const exitCode = await executeCli(["model", "setup"], {
      environment,
      fetcher,
      prompt,
      write: vi.fn(),
    });

    expect(exitCode).toBe(0);
    expect(profileBody).not.toHaveProperty("maxInputTokens");
    expect(profileBody).not.toHaveProperty("contextWindowSource");
  });

  it("returns success when interactive Verification is cancelled without mutating active state", async () => {
    const requests: string[] = [];
    const output: string[] = [];
    const prompt = scriptedPrompt({
      selects: ["deepseek", "environment", "deepseek-v4-flash", "operator"],
      inputs: ["deepseek", "DeepSeek", "https://api.deepseek.com", "DEEPSEEK_API_KEY", "deepseek-flash", "DeepSeek Flash", "65536", ""],
      confirmations: [true, false],
    });
    const fetcher = createFetcher((request) => {
      requests.push(`${request.method} ${request.path}`);
      if (request.path === "/v1/admin/model-verifications/ver_1") {
        return jsonResponse({ ...verification("passed"), status: "cancelled", resultCode: null });
      }
      return setupResponse(request);
    });

    const exitCode = await executeCli(["model", "setup", "--json"], {
      environment,
      fetcher,
      prompt,
      sleep: async () => undefined,
      write: (line) => output.push(line),
    });

    expect(exitCode).toBe(0);
    expect(requests.some((request) => request.includes("promotions"))).toBe(false);
    expect(output.at(-1)).toBe('{"status":"cancelled","traceId":"verification-trace"}');
  });

  it("reviews warnings before confirmed Promotion, default, and Agent assignment", async () => {
    const requests: string[] = [];
    const output: string[] = [];
    const confirmations: string[] = [];
    let promotionConfirmed = false;
    const values = {
      selects: ["deepseek", "environment", "deepseek-v4-flash", "operator"],
      inputs: ["deepseek", "DeepSeek", "https://api.deepseek.com", "DEEPSEEK_API_KEY", "deepseek-flash", "DeepSeek Flash", "65536", "primary"],
      confirmations: [true, true, true],
    };
    const prompt: CliPrompt = {
      select: async <T extends string>() => values.selects.shift() as T,
      input: async () => values.inputs.shift()!,
      secret: async () => { throw new Error("unexpected_secret_prompt"); },
      confirm: async (message) => {
        confirmations.push(message);
        const answer = values.confirmations.shift()!;
        if (message === "Promote the verified connection and model profile?") promotionConfirmed = answer;
        return answer;
      },
    };
    const fetcher = createFetcher((request) => {
      requests.push(`${request.method} ${request.path}`);
      const snapshotRead = request.method === "GET" && (
        request.path === "/v1/admin/model-profiles/deepseek-flash" ||
        request.path === "/v1/admin/default-model-profile" ||
        request.path.endsWith("/model-assignment")
      );
      if (snapshotRead && promotionConfirmed) throw new Error("snapshot_after_confirmation");
      const mutation = request.method !== "GET" && (
        request.path.includes("/promotions") ||
        request.path === "/v1/admin/default-model-profile" ||
        request.path.includes("/model-assignment")
      );
      if (mutation && !promotionConfirmed) throw new Error("mutation_before_confirmation");
      if (request.path === "/v1/admin/model-profiles/deepseek-flash") return jsonResponse({ ...profileResponse(), recordRevision: 2 });
      if (request.method === "GET" && request.path === "/v1/admin/default-model-profile") return jsonResponse({ state: "unset", profileId: null, recordRevision: null });
      if (request.method === "GET" && request.path.endsWith("/model-assignment")) return jsonResponse({ agentId: "primary", state: "unassigned", modelProfileRevisionId: null, source: null, recordRevision: null, updatedAt: null });
      return setupResponse(request);
    });

    const exitCode = await executeCli(["model", "setup"], {
      environment,
      fetcher,
      prompt,
      sleep: async () => undefined,
      write: (line) => output.push(line),
    });

    expect(exitCode).toBe(0);
    expect(confirmations).toEqual([
      "Use resolved context limit of 65536 tokens from operator?",
      "Make this model profile the default after Promotion?",
      "Promote the verified connection and model profile?",
    ]);
    expect(output).toContain("Warnings: none");
    expect(requests).toEqual(expect.arrayContaining([
      "POST /v1/admin/provider-connections/deepseek/promotions",
      "POST /v1/admin/model-profiles/deepseek-flash/promotions",
      "PUT /v1/admin/default-model-profile",
      "PUT /v1/admin/agents/primary/model-assignment",
    ]));
  });
});

interface CapturedRequest {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
}

function createFetcher(handle: (request: CapturedRequest) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return await handle({
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      authorization: new Headers(init?.headers).get("authorization"),
    });
  }) as typeof fetch;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function verification(status: "running" | "passed") {
  return {
    verificationId: "ver_1",
    profileRevisionId: "mpr_1",
    capabilityBaseline: "text_and_single_tool_call_v1",
    status,
    resultCode: null,
    safeStatus: null,
    capabilities: status === "passed" ? ["streaming_text", "single_tool_call"] : [],
    usage: status === "passed" ? { inputTokens: 3, outputTokens: 2 } : undefined,
    traceId: "verification-trace",
    recordRevision: status === "passed" ? 3 : 2,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    cancellationRequestedAt: null,
    fallbackProfileRevisionId: null,
    fallbackVerificationId: null,
  };
}

function scriptedPrompt(values: {
  selects: string[];
  inputs: string[];
  confirmations: boolean[];
}): CliPrompt {
  return {
    select: async <T extends string>() => values.selects.shift() as T,
    input: async () => values.inputs.shift()!,
    secret: async () => { throw new Error("unexpected_secret_prompt"); },
    confirm: async () => values.confirmations.shift()!,
  };
}

function setupFetcher(requests: string[]): typeof fetch {
  return createFetcher((request) => {
    requests.push(`${request.method} ${request.path}`);
    return setupResponse(request);
  });
}

function setupResponse(request: CapturedRequest): Response {
  if (request.path === "/v1/admin/provider-connections") return jsonResponse({ connectionId: "deepseek", displayName: "DeepSeek", providerKind: "deepseek", activeRevisionId: null, retiredAt: null, recordRevision: 0, credentialConfigured: true, revisions: [{ revisionId: "pcr_1", connectionId: "deepseek", state: "draft", baseUrl: "https://api.deepseek.com", allowInsecureHttp: false, protocolPreference: "responses", presetVersion: "1", credentialConfigured: true, createdAt: "2026-08-10T00:00:00.000Z" }] }, 201);
  if (request.path.endsWith("/discover")) return jsonResponse({ connectionRevisionId: "pcr_1", recordRevision: 1, state: "fresh", models: [{ id: "deepseek-v4-flash" }], cache: { fetchedAt: "2026-08-10T00:00:00.000Z", expiresAt: "2026-08-10T01:00:00.000Z" }, error: null });
  if (request.path === "/v1/admin/model-profiles") return jsonResponse(profileResponse(), 201);
  if (request.method === "POST" && request.path.endsWith("/verifications")) return jsonResponse({ verificationId: "ver_1", profileRevisionId: "mpr_1", capabilityBaseline: "text_and_single_tool_call_v1", status: "queued", recordRevision: 1, operationUrl: "/v1/admin/model-verifications/ver_1" }, 202);
  if (request.path === "/v1/admin/model-verifications/ver_1") return jsonResponse(verification("passed"));
  return jsonResponse({ ok: true });
}

function profileResponse() {
  return { profileId: "deepseek-flash", displayName: "DeepSeek Flash", activeRevisionId: null, retiredAt: null, recordRevision: 0, revisions: [{ revisionId: "mpr_1", profileId: "deepseek-flash", connectionRevisionId: "pcr_1", providerModelId: "deepseek-v4-flash", invocationProtocol: "responses", maxInputTokens: 65536, contextWindowSource: "operator", capabilityBaseline: "text_and_single_tool_call_v1", verifiedCapabilities: [], state: "draft", createdAt: "2026-08-10T00:00:00.000Z" }] };
}
