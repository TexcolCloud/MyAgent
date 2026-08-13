import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { bootstrap } from "../../src/bootstrap.js";
import type { ProviderEgressGatewayListen } from "../../src/adapters/provider-egress-gateway.js";
import { executeCli } from "../../src/interfaces/cli/main.js";
import { FakeOpenAiProvider } from "../helpers/fake-openai-provider.js";
import {
  createAsyncCleanupStack,
  startRealTestApp,
} from "../helpers/start-test-app.js";

describe("multi-provider model registry release isolation", () => {
  it("closes the provider gateway when later service startup fails", async () => {
    const cleanup = createAsyncCleanupStack();
    try {
      const occupied = cleanup.use(
        await FakeOpenAiProvider.start({ models: ["occupied"] }),
        (active) => active.close(),
      );
      const fixture = cleanup.use(await startRealTestApp(), (active) => active.close());
      await fixture.stop();
      let gatewayUrl = "";
      let gatewayStops = 0;

      const startup = await bootstrap(fixture.configPath, {
        listen: {
          host: "127.0.0.1",
          port: Number(new URL(occupied.baseUrl).port),
        },
        signals: false,
        providerGateway: {
          listen: captureGatewayUrl((url) => { gatewayUrl = url; }),
          onStopped: () => { gatewayStops += 1; },
        },
      }).then(
        (service) => ({ service }),
        (error: unknown) => ({ error }),
      );
      if ("service" in startup) await startup.service.shutdown();

      expect("error" in startup).toBe(true);
      expect(gatewayUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect(gatewayStops).toBe(1);
      await expect(fetch(gatewayUrl, { signal: AbortSignal.timeout(1_000) }))
        .rejects.toThrow();
    } finally {
      await cleanup.dispose();
    }
  });

  it("closes the provider gateway during normal service shutdown", async () => {
    const cleanup = createAsyncCleanupStack();
    try {
      const fixture = cleanup.use(await startRealTestApp(), (active) => active.close());
      await fixture.stop();
      let gatewayUrl = "";
      let gatewayStops = 0;
      const service = await bootstrap(fixture.configPath, {
        listen: { host: "127.0.0.1", port: 0 },
        signals: false,
        providerGateway: {
          listen: captureGatewayUrl((url) => { gatewayUrl = url; }),
          onStopped: () => { gatewayStops += 1; },
        },
      });

      await service.shutdown();
      await service.shutdown();

      expect(gatewayStops).toBe(1);
      await expect(fetch(gatewayUrl, { signal: AbortSignal.timeout(1_000) }))
        .rejects.toThrow();
    } finally {
      await cleanup.dispose();
    }
  });

  it("keeps HTTP controls available when the Pi gateway listener cannot start", async () => {
    const cleanup = createAsyncCleanupStack();
    try {
      const fixture = cleanup.use(await startRealTestApp(), (active) => active.close());
      await fixture.stop();
      let gatewayStops = 0;
      const service = await bootstrap(fixture.configPath, {
        listen: { host: "127.0.0.1", port: 0 },
        signals: false,
        providerGateway: {
          listen: async () => { throw new Error("gateway_listener_unavailable"); },
          onStopped: () => { gatewayStops += 1; },
        },
      });

      const ready = await fetch(`${service.url}/readyz`);
      await service.shutdown();

      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ ready: true });
      expect(gatewayStops).toBe(1);
    } finally {
      await cleanup.dispose();
    }
  });

  it("keeps an active Pi assignment byte-stable when gateway startup fails", async () => {
    const providerSecret = "PI_GATEWAY_FAILURE_SECRET_MARKER";
    const previousSecret = process.env.RELEASE_PI_API_KEY;
    process.env.RELEASE_PI_API_KEY = providerSecret;
    const cleanup = createAsyncCleanupStack();
    try {
      const provider = cleanup.use(await FakeOpenAiProvider.start({
        models: ["deepseek-v4-flash"],
        expectedApiKey: providerSecret,
        chat: [
          { type: "verification_text", text: "Pi verification passed" },
          { type: "verification_tool", callId: "verify-pi-gateway-failure" },
        ],
      }), (active) => active.close());
      const fixture = cleanup.use(await startRealTestApp(), (active) => active.close());
      await fixture.setupVerifiedModel({
        connectionSlug: "pi-gateway-failure",
        profileSlug: "pi-gateway-failure",
        providerBaseUrl: provider.baseUrl,
        modelId: "deepseek-v4-flash",
        protocol: "responses",
        driverId: "pi/deepseek",
        catalogCandidateId: "pi/deepseek:deepseek-v4-flash",
        apiKeyEnvironment: "RELEASE_PI_API_KEY",
        agentId: "primary",
      });
      const frozenAssignment = assignmentSnapshot(fixture.databasePath, "primary");
      await fixture.stop();
      provider.clearCapturedRequests();
      let gatewayStops = 0;
      const service = await bootstrap(fixture.configPath, {
        listen: { host: "127.0.0.1", port: 0 },
        signals: false,
        providerGateway: {
          listen: async () => { throw new Error("gateway_listener_unavailable"); },
          onStopped: () => { gatewayStops += 1; },
        },
      });
      cleanup.use(service, (active) => active.shutdown());

      const ready = await fetch(`${service.url}/readyz`);
      const assignmentResponse = await serviceRequest(
        service.url,
        "admin-test-token",
        "/v1/admin/agents/primary/model-assignment",
      );
      const run = await jsonRequest(serviceRequest(
        service.url,
        "run-test-token",
        "/v1/runs",
        {
          method: "POST",
          headers: { "idempotency-key": "pi-gateway-failure-run" },
          body: JSON.stringify({
            agentId: "primary",
            sessionKey: "release:pi-gateway-failure",
            input: { type: "text", text: "This must fail closed." },
          }),
        },
      ), 202) as { runId: string };
      const failed = await waitForRunState(service.url, run.runId, "failed");

      expect({ status: ready.status, body: await ready.json() }).toEqual({
        status: 200,
        body: { ready: true },
      });
      expect({ status: assignmentResponse.status, body: await assignmentResponse.json() })
        .toMatchObject({ status: 200, body: { state: "assigned" } });
      expect(failed).toMatchObject({
        status: "failed",
        failure: { code: "provider_unavailable" },
      });
      expect(assignmentSnapshot(fixture.databasePath, "primary"))
        .toBe(frozenAssignment);
      expect(provider.chatRequests).toEqual([]);
      expect(provider.responsesRequests).toEqual([]);
      await service.shutdown();
      expect(gatewayStops).toBe(1);
    } finally {
      restoreEnvironment("RELEASE_PI_API_KEY", previousSecret);
      await cleanup.dispose();
    }
  }, 25_000);

  it("runs a new Pi profile through the gateway without exposing its Secret", async () => {
    const providerSecret = "PI_PROVIDER_SECRET_RELEASE_MARKER";
    const previousSecret = process.env.RELEASE_PI_API_KEY;
    process.env.RELEASE_PI_API_KEY = providerSecret;
    const gatewayRequests: string[] = [];
    const cleanup = createAsyncCleanupStack();
    try {
      const provider = cleanup.use(await FakeOpenAiProvider.start({
        models: ["deepseek-v4-flash"],
        expectedApiKey: providerSecret,
        chat: [
          { type: "verification_text", text: "Pi text verification passed" },
          { type: "verification_tool", callId: "verify-pi-gateway" },
          { type: "text", text: "Pi gateway run completed" },
        ],
      }), (active) => active.close());
      const service = cleanup.use(await startRealTestApp({
        providerGateway: {
          listen: captureGatewayTraffic(gatewayRequests),
        },
      }), (active) => active.close());
      const setup = await service.setupVerifiedModel({
        connectionSlug: "pi-gateway-release",
        profileSlug: "pi-gateway-release",
        providerBaseUrl: provider.baseUrl,
        modelId: "deepseek-v4-flash",
        protocol: "responses",
        driverId: "pi/deepseek",
        catalogCandidateId: "pi/deepseek:deepseek-v4-flash",
        apiKeyEnvironment: "RELEASE_PI_API_KEY",
        agentId: "primary",
      });
      const run = await service.createRun({
        agentId: "primary",
        sessionKey: "release:pi-gateway",
        text: "Complete through the controlled Pi route.",
        idempotencyKey: "pi-gateway-release-run",
      });
      await service.waitForRunStatus(run.runId, "completed");
      const events = await service.readRunEvents(run.runId);
      const runResponse = await service.runRequest(`/v1/runs/${run.runId}`);
      const runView = await runResponse.json();

      expect(gatewayRequests.length).toBeGreaterThanOrEqual(3);
      expect(gatewayRequests.every((requestPath) => requestPath.startsWith("/pi/")))
        .toBe(true);
      expect(provider.chatRequests).toHaveLength(3);
      expect(provider.chatRequests.every(({ credentialMatched }) => credentialMatched))
        .toBe(true);
      expect(JSON.stringify({
        setup,
        setupResponses: service.setupResponseBodies,
        events,
        runView,
        logs: service.logs,
        gatewayRequests,
        providerRequests: provider.chatRequests,
      })).not.toContain(providerSecret);
      expect((await readFile(service.databasePath)).includes(Buffer.from(providerSecret)))
        .toBe(false);
    } finally {
      restoreEnvironment("RELEASE_PI_API_KEY", previousSecret);
      await cleanup.dispose();
    }
  }, 30_000);

  it("runs a manually selected OpenAI-compatible Profile through the Pi gateway", async () => {
    const gatewayRequests: string[] = [];
    const cleanup = createAsyncCleanupStack();
    try {
      const provider = cleanup.use(await FakeOpenAiProvider.start({
        models: ["manual-compatible-model"],
        chat: [
          { type: "verification_text", text: "Manual verification passed" },
          { type: "verification_tool", callId: "verify-manual-compatible" },
          { type: "text", text: "Manual Pi gateway run completed" },
        ],
      }), (active) => active.close());
      const service = cleanup.use(await startRealTestApp({
        providerGateway: {
          listen: captureGatewayTraffic(gatewayRequests),
        },
      }), (active) => active.close());
      await service.setupVerifiedModel({
        connectionSlug: "manual-pi-gateway",
        profileSlug: "manual-pi-gateway",
        providerBaseUrl: provider.baseUrl,
        modelId: "manual-compatible-model",
        protocol: "chat_completions",
        agentId: "primary",
      });
      const run = await service.createRun({
        agentId: "primary",
        sessionKey: "release:manual-pi-gateway",
        text: "Use the persisted Pi runtime.",
        idempotencyKey: "manual-pi-gateway-run",
      });

      await service.waitForRunStatus(run.runId, "completed");

      expect(gatewayRequests).toHaveLength(3);
      expect(gatewayRequests.every((requestPath) => requestPath.startsWith("/pi/")))
        .toBe(true);
      expect(provider.chatRequests).toHaveLength(3);
      const manualRunPayload = provider.chatRequests[2]?.body;
      expect(manualRunPayload).toMatchObject({
        model: "manual-compatible-model",
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("Use the persisted Pi runtime."),
          }),
        ]),
        stream: true,
        tools: expect.arrayContaining([
          expect.objectContaining({
            type: "function",
            function: expect.objectContaining({ name: "read_file" }),
          }),
        ]),
      });
      expect(manualRunPayload).not.toHaveProperty("store");
      expect(manualRunPayload).not.toHaveProperty("tools[0].function.strict");
    } finally {
      await cleanup.dispose();
    }
  }, 30_000);

  it("keeps a manual Responses payload compatible through the Pi gateway", async () => {
    const cleanup = createAsyncCleanupStack();
    try {
      const provider = cleanup.use(await FakeOpenAiProvider.start({
        models: ["manual-compatible-responses"],
        responses: [
          { type: "verification_text", text: "Manual Responses verification passed" },
          { type: "verification_tool", callId: "verify-manual-responses" },
          { type: "text", text: "Manual Responses gateway run completed" },
        ],
      }), (active) => active.close());
      const service = cleanup.use(await startRealTestApp(), (active) => active.close());
      await service.setupVerifiedModel({
        connectionSlug: "manual-responses-gateway",
        profileSlug: "manual-responses-gateway",
        providerBaseUrl: provider.baseUrl,
        modelId: "manual-compatible-responses",
        protocol: "responses",
        agentId: "primary",
      });
      const run = await service.createRun({
        agentId: "primary",
        sessionKey: "release:manual-responses-gateway",
        text: "Use the persisted manual Responses runtime.",
        idempotencyKey: "manual-responses-gateway-run",
      });

      await service.waitForRunStatus(run.runId, "completed");

      expect(provider.responsesRequests).toHaveLength(3);
      const manualRunPayload = provider.responsesRequests[2]?.body;
      expect(manualRunPayload).toMatchObject({
        model: "manual-compatible-responses",
        input: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
          }),
        ]),
        stream: true,
        tools: expect.arrayContaining([
          expect.objectContaining({ type: "function", name: "read_file" }),
        ]),
      });
      expect(JSON.stringify(manualRunPayload)).toContain(
        "Use the persisted manual Responses runtime.",
      );
      expect(manualRunPayload).not.toHaveProperty("store");
      expect(manualRunPayload).not.toHaveProperty("tools[0].strict");
    } finally {
      await cleanup.dispose();
    }
  }, 30_000);

  it("fails a native DeepSeek Responses run before proposing either of two tool calls", async () => {
    const rawProviderBody = "RAW_MULTI_TOOL_PROVIDER_BODY_SENTINEL_16";
    const effectFileName = "multi-tool-must-not-execute.log";
    const cleanup = createAsyncCleanupStack();

    try {
      const provider = cleanup.use(await FakeOpenAiProvider.start({
        models: ["deepseek-v4-flash"],
        responses: [
          { type: "verification_text", text: "DeepSeek Responses verification passed" },
          { type: "verification_tool", callId: "verify-deepseek-responses-multi" },
          {
            type: "multi_tool",
            calls: [
              {
                callId: "provider-multi-call-1",
                name: "run_command",
                arguments: {
                  program: process.execPath,
                  args: [
                    "-e",
                    `require('node:fs').appendFileSync('${effectFileName}','executed\\n')`,
                  ],
                  cwd: ".",
                  env: {},
                  timeoutMs: 5_000,
                },
              },
              {
                callId: "provider-multi-call-2",
                name: "write_file",
                arguments: {
                  path: effectFileName,
                  content: "executed",
                  expectedSha256: null,
                },
              },
            ],
            rawBody: rawProviderBody,
          },
        ],
      }), (active) => active.close());
      const service = cleanup.use(await startRealTestApp(), (active) => active.close());
      await service.setupVerifiedModel({
        connectionSlug: "deepseek-responses-multi",
        profileSlug: "deepseek-responses-multi",
        providerBaseUrl: provider.baseUrl,
        modelId: "deepseek-v4-flash",
        protocol: "responses",
        driverId: "pi/deepseek",
        catalogCandidateId: "pi/deepseek:deepseek-v4-flash-responses",
        apiKeyEnvironment: "MYAGENT_BEARER_TOKEN",
        agentId: "primary",
      });
      provider.clearCapturedRequests();

      const run = await service.createRun({
        agentId: "primary",
        sessionKey: "deepseek:responses:multiple-tools",
        text: "This malformed response must fail closed.",
        idempotencyKey: "deepseek-responses-multiple-tools-run",
      });
      expect(await service.waitForRunStatus(run.runId, "failed")).toBeDefined();
      await expect(service.onlyPendingApproval()).rejects.toThrow();

      const runResponse = await service.runRequest(`/v1/runs/${run.runId}`);
      expect(runResponse.status).toBe(200);
      const runView = await runResponse.json() as Record<string, unknown>;
      expect(runView).toMatchObject({
        status: "failed",
        failure: { code: "model_protocol_error" },
      });
      expect((runView.failure as Record<string, unknown>)).toEqual({
        code: "model_protocol_error",
      });

      const events = await service.readRunEvents(run.runId);
      expect(events.map(({ type }) => type)).not.toEqual(expect.arrayContaining([
        "tool.proposed",
        "tool.policy_decided",
        "approval.required",
        "tool.started",
        "tool.completed",
        "tool.failed",
      ]));
      expect(existsSync(path.join(service.primaryWorkspace, effectFileName))).toBe(false);

      const database = new DatabaseSync(service.databasePath, { readOnly: true });
      let databaseStrings = "";
      try {
        expect(database.prepare(
          "SELECT COUNT(*) AS count FROM tool_calls WHERE run_id = ?",
        ).get(run.runId)).toEqual({ count: 0 });
        databaseStrings = JSON.stringify({
          run: database.prepare(
            "SELECT state, failure_code FROM runs WHERE run_id = ?",
          ).get(run.runId),
          events: database.prepare(
            "SELECT event_type, payload_json FROM run_events WHERE run_id = ? ORDER BY sequence",
          ).all(run.runId),
          health: database.prepare(
            "SELECT outcome, code, safe_status FROM provider_health WHERE profile_revision_id IS NOT NULL",
          ).all(),
          approvals: database.prepare(
            "SELECT state FROM approvals WHERE run_id = ?",
          ).all(run.runId),
        });
      } finally {
        database.close();
      }

      expect(provider.rawResponseBodies.join("\n")).toContain(rawProviderBody);
      expect(JSON.stringify({ events, logs: service.logs, runView, databaseStrings }))
        .not.toContain(rawProviderBody);
    } finally {
      await cleanup.dispose();
    }
  }, 30_000);

  it("cleans partial service startup before closing an earlier provider", async () => {
    const cleanup = createAsyncCleanupStack();
    let providerModelsUrl = "";
    try {
      const provider = cleanup.use(
        await FakeOpenAiProvider.start({ models: ["cleanup-model"] }),
        (active) => active.close(),
      );
      providerModelsUrl = `${provider.baseUrl}/models`;
      const occupiedPort = Number(new URL(provider.baseUrl).port);
      const previousEnvironment = {
        runToken: process.env.MYAGENT_BEARER_TOKEN,
        adminToken: process.env.MYAGENT_ADMIN_TOKEN,
        masterKey: process.env.MYAGENT_MASTER_KEY,
      };
      let failedRoot = "";
      const startup = await startRealTestApp({
        listenPort: occupiedPort,
        onRootCreated: (root: string) => { failedRoot = root; },
      }).then(
        (service) => ({ service }),
        (error: unknown) => ({ error }),
      );
      if ("service" in startup) await startup.service.close();

      expect("error" in startup).toBe(true);
      if (!("error" in startup)) throw new Error("expected_startup_failure");
      expect(String(startup.error)).toMatch(/EADDRINUSE|address already in use/i);
      expect(failedRoot.length).toBeGreaterThan(0);
      expect(existsSync(failedRoot)).toBe(false);
      expect(process.env.MYAGENT_BEARER_TOKEN).toBe(previousEnvironment.runToken);
      expect(process.env.MYAGENT_ADMIN_TOKEN).toBe(previousEnvironment.adminToken);
      expect(process.env.MYAGENT_MASTER_KEY).toBe(previousEnvironment.masterKey);
      expect((await fetch(providerModelsUrl)).status).toBe(200);
    } finally {
      await cleanup.dispose();
    }
    await expect(fetch(providerModelsUrl, { signal: AbortSignal.timeout(1_000) }))
      .rejects.toThrow();
  });

  it("honors the caller's Verification polling deadline", async () => {
    const cleanup = createAsyncCleanupStack();

    try {
      const provider = cleanup.use(await FakeOpenAiProvider.start({
        models: ["slow-verification-model"],
        chat: [{
          type: "verification_text",
          text: "slow verification response",
          delayMs: 200,
        }],
      }), (active) => active.close());
      const service = cleanup.use(await startRealTestApp(), (active) => active.close());
      const input = {
        connectionSlug: "slow-verification",
        profileSlug: "slow-verification",
        providerBaseUrl: provider.baseUrl,
        modelId: "slow-verification-model",
        protocol: "chat_completions" as const,
        agentId: "primary",
        verificationTimeoutMs: 50,
      } as Parameters<typeof service.setupVerifiedModel>[0];
      await expect(service.setupVerifiedModel(input)).rejects.toThrow(/verification_timeout:/);
    } finally {
      await cleanup.dispose();
    }
  }, 10_000);

  it("runs separate Chat and Responses profiles without Session, Tool, or provider-request leakage", async () => {
    const chatMarker = "CHAT_AGENT_REQUEST_MARKER";
    const responsesMarker = "RESPONSES_AGENT_REQUEST_MARKER";
    const chatCallId = "chat-isolation-call-16";
    const responsesCallId = "responses-isolation-call-16";
    const chatToolArgument = "CHAT_TOOL_ARGUMENT_MARKER_16";
    const chatToolResult = createHash("sha256").update(chatToolArgument).digest("hex");
    const responsesToolResult = "RESPONSES_TOOL_RESULT_MARKER_16";
    const encodedResponsesResult = Buffer.from(responsesToolResult).toString("base64");
    const cleanup = createAsyncCleanupStack();

    try {
      const provider = cleanup.use(await FakeOpenAiProvider.start({
        models: ["chat-release-model", "responses-release-model"],
        chat: [
        { type: "verification_text", text: "chat verification passed" },
        { type: "verification_tool", callId: "verify-chat-call" },
        {
          type: "tool",
          callId: chatCallId,
          name: "write_file",
          arguments: {
            path: "chat-isolation.txt",
            content: chatToolArgument,
            expectedSha256: null,
          },
        },
        { type: "text", text: "chat agent completed" },
        ],
        responses: [
        { type: "verification_text", text: "responses verification passed" },
        { type: "verification_tool", callId: "verify-responses-call" },
        {
          type: "tool",
          callId: responsesCallId,
          name: "run_command",
          arguments: {
            program: process.execPath,
            args: [
              "-e",
              `process.stdout.write(Buffer.from("${encodedResponsesResult}", "base64").toString("utf8"))`,
            ],
            cwd: ".",
            env: {},
            timeoutMs: 5_000,
          },
        },
        { type: "text", text: "responses agent completed" },
        ],
      }), (active) => active.close());
      const service = cleanup.use(await startRealTestApp(), (active) => active.close());
      const chat = await service.setupVerifiedModel({
        connectionSlug: "chat-release",
        profileSlug: "chat-release",
        providerBaseUrl: provider.baseUrl,
        modelId: "chat-release-model",
        protocol: "chat_completions",
        agentId: "primary",
      });
      const responses = await service.setupVerifiedModel({
        connectionSlug: "responses-release",
        profileSlug: "responses-release",
        providerBaseUrl: provider.baseUrl,
        modelId: "responses-release-model",
        protocol: "responses",
        agentId: "researcher",
      });
      provider.clearCapturedRequests();

      const [chatRun, responsesRun] = await Promise.all([
        service.createRun({
          agentId: "primary",
          sessionKey: "shared:model-registry-key",
          text: chatMarker,
          idempotencyKey: "chat-release-request-01",
        }),
        service.createRun({
          agentId: "researcher",
          sessionKey: "shared:model-registry-key",
          text: responsesMarker,
          idempotencyKey: "responses-release-request-01",
        }),
      ]);
      await Promise.all([
        service.waitForRunEvent(chatRun.runId, "approval.required"),
        service.waitForRunEvent(responsesRun.runId, "approval.required"),
      ]);
      const approvalsResponse = await service.runRequest("/v1/approvals?status=pending");
      expect(approvalsResponse.status).toBe(200);
      const approvals = await approvalsResponse.json() as {
        approvals: Array<{ approvalId: string; runId: string }>;
      };
      expect(new Set(approvals.approvals.map(({ runId }) => runId))).toEqual(
        new Set([chatRun.runId, responsesRun.runId]),
      );
      await Promise.all(approvals.approvals.map(({ approvalId }) => service.approve(approvalId)));
      await Promise.all([
        service.waitForRunStatus(chatRun.runId, "completed"),
        service.waitForRunStatus(responsesRun.runId, "completed"),
      ]);

      expect(provider.chatRequests).toHaveLength(2);
      expect(provider.responsesRequests).toHaveLength(2);
      const chatRequest = JSON.stringify(provider.chatRequests);
      const responsesRequest = JSON.stringify(provider.responsesRequests);
      expect(chatRequest).toContain(chatMarker);
      expect(chatRequest).not.toContain(responsesMarker);
      expect(responsesRequest).toContain(responsesMarker);
      expect(responsesRequest).not.toContain(chatMarker);
      expect(chatRequest).not.toContain("Researcher Agent");
      expect(responsesRequest).not.toContain("Primary Agent");
      const chatHistory = JSON.stringify(
        (provider.chatRequests[1]!.body as { messages?: unknown }).messages,
      );
      const responsesHistory = JSON.stringify(
        (provider.responsesRequests[1]!.body as { input?: unknown }).input,
      );
      for (const own of [
        chatMarker,
        chatCallId,
        "write_file",
        chatToolArgument,
        chatToolResult,
      ]) {
        expect(chatHistory).toContain(own);
        expect(responsesHistory).not.toContain(own);
      }
      for (const own of [
        responsesMarker,
        responsesCallId,
        "run_command",
        encodedResponsesResult,
        responsesToolResult,
      ]) {
        expect(responsesHistory).toContain(own);
        expect(chatHistory).not.toContain(own);
      }
      expect(await readFile(path.join(service.primaryWorkspace, "chat-isolation.txt"), "utf8"))
        .toBe(chatToolArgument);
      expect([...provider.chatRequests, ...provider.responsesRequests].every((request) =>
        !("authorization" in request))).toBe(true);

      const database = new DatabaseSync(service.databasePath, { readOnly: true });
      try {
        const sessions = database.prepare(
          `SELECT session_id, agent_id, session_key FROM sessions
           WHERE session_key = ? ORDER BY agent_id`,
        ).all("shared:model-registry-key") as Array<{
          session_id: string;
          agent_id: string;
          session_key: string;
        }>;
        expect(sessions).toHaveLength(2);
        expect(sessions.map(({ agent_id }) => agent_id)).toEqual(["primary", "researcher"]);
        expect(new Set(sessions.map(({ session_id }) => session_id)).size).toBe(2);
        expect(database.prepare(
          `SELECT sessions.agent_id,
                  json_extract(agent_revisions.content_json, '$.modelProfileRevisionId')
                    AS model_profile_revision_id,
                  json_extract(agent_revisions.content_json, '$.model.invocationProtocol')
                    AS invocation_protocol
           FROM runs
           JOIN sessions ON sessions.session_id = runs.session_id
           JOIN agent_revisions ON agent_revisions.revision_id = runs.agent_revision_id
           WHERE runs.run_id IN (?, ?) ORDER BY sessions.agent_id`,
        ).all(chatRun.runId, responsesRun.runId)).toEqual([
          {
            agent_id: "primary",
            model_profile_revision_id: chat.profileRevisionId,
            invocation_protocol: "chat_completions",
          },
          {
            agent_id: "researcher",
            model_profile_revision_id: responses.profileRevisionId,
            invocation_protocol: "responses",
          },
        ]);
      } finally {
        database.close();
      }
    } finally {
      await cleanup.dispose();
    }
  }, 30_000);

  it("contains managed plaintext and raw provider fields across the composed system", async () => {
    const managedPlaintext = "MANAGED_PLAINTEXT_COMPOSED_MARKER_16";
    const rawReasoning = "RAW_REASONING_COMPOSED_MARKER_16";
    const rawResponsesReasoning = "RAW_RESPONSES_REASONING_COMPOSED_MARKER_16";
    const rawProviderBody = "RAW_PROVIDER_BODY_COMPOSED_MARKER_16";
    const cleanup = createAsyncCleanupStack();

    try {
      const provider = cleanup.use(await FakeOpenAiProvider.start({
        models: ["containment-chat-model", "containment-responses-model"],
        expectedApiKey: managedPlaintext,
        chat: [
        { type: "verification_text", text: "containment verification passed" },
        { type: "verification_tool", callId: "verify-containment-call" },
        {
          type: "text",
          text: "normalized containment completion",
          reasoning: rawReasoning,
          rawBody: rawProviderBody,
        },
        ],
        responses: [
        { type: "verification_text", text: "Responses containment verification passed" },
        { type: "verification_tool", callId: "verify-responses-containment-call" },
        {
          type: "text",
          text: "normalized Responses containment completion",
          reasoning: rawResponsesReasoning,
          rawBody: rawProviderBody,
        },
        ],
      }), (active) => active.close());
      const service = cleanup.use(await startRealTestApp(), (active) => active.close());
      const setup = await service.setupVerifiedModel({
        connectionSlug: "composed-containment",
        profileSlug: "composed-containment",
        providerBaseUrl: provider.baseUrl,
        modelId: "containment-chat-model",
        protocol: "chat_completions",
        agentId: "primary",
        apiKey: managedPlaintext,
      });
      const responsesSetup = await service.setupVerifiedModel({
        connectionSlug: "composed-responses-containment",
        profileSlug: "composed-responses-containment",
        providerBaseUrl: provider.baseUrl,
        modelId: "containment-responses-model",
        protocol: "responses",
        agentId: "researcher",
      });
      const setupResponseBodies = service.setupResponseBodies;
      expect(setupResponseBodies.length).toBeGreaterThan(0);
      provider.clearCapturedRequests();

      const [chatRun, responsesRun] = await Promise.all([
        service.createRun({
          agentId: "primary",
          sessionKey: "composed:containment",
          text: "Exercise the normalized Chat provider boundary.",
          idempotencyKey: "composed-containment-chat-run",
        }),
        service.createRun({
          agentId: "researcher",
          sessionKey: "composed:containment",
          text: "Exercise the normalized Responses provider boundary.",
          idempotencyKey: "composed-containment-responses-run",
        }),
      ]);
      await Promise.all([
        service.waitForRunStatus(chatRun.runId, "completed"),
        service.waitForRunStatus(responsesRun.runId, "completed"),
      ]);

      const httpJson: string[] = [];
      for (const [authority, pathname] of [
        ["run", "/healthz"],
        ["run", "/readyz"],
        ["run", `/v1/runs/${chatRun.runId}`],
        ["run", `/v1/runs/${responsesRun.runId}`],
        ["admin", "/provider-connections"],
        ["admin", `/provider-connections/${setup.connectionId}`],
        ["admin", "/model-profiles"],
        ["admin", `/model-verifications/${setup.verificationId}`],
        ["admin", `/model-verifications/${responsesSetup.verificationId}`],
        ["admin", "/agents/primary/model-assignment"],
        ["admin", "/agents/researcher/model-assignment"],
      ] as const) {
        const response = authority === "admin"
          ? await service.adminRequest(pathname)
          : await service.runRequest(pathname);
        expect(response.status).toBe(200);
        httpJson.push(await response.text());
      }

      const sseResponses = await Promise.all([
        service.runRequest(`/v1/runs/${chatRun.runId}/events`),
        service.runRequest(`/v1/runs/${responsesRun.runId}/events`),
      ]);
      expect(sseResponses.every(({ status }) => status === 200)).toBe(true);
      const sse = (await Promise.all(sseResponses.map((response) => response.text()))).join("\n");
      expect(sse).toContain("run.completed");
      expect(httpJson.length).toBeGreaterThan(0);
      expect(service.logs.length).toBeGreaterThan(0);

      const cliOutput: string[] = [];
      const cliErrors: string[] = [];
      const environment = {
        MYAGENT_API_URL: service.url,
        MYAGENT_BEARER_TOKEN: "run-test-token",
        MYAGENT_ADMIN_TOKEN: "admin-test-token",
      };
      expect(await executeCli(["providers", "list", "--json"], {
        environment,
        write: (line) => cliOutput.push(line),
        writeError: (line) => cliErrors.push(line),
      })).toBe(0);
      expect(await executeCli(["run", "watch", chatRun.runId], {
        environment,
        write: (line) => cliOutput.push(line),
        writeError: (line) => cliErrors.push(line),
      })).toBe(0);
      expect(await executeCli(["run", "watch", responsesRun.runId], {
        environment,
        write: (line) => cliOutput.push(line),
        writeError: (line) => cliErrors.push(line),
      })).toBe(0);
      expect(await executeCli(["providers", "list", "--not-a-real-option"], {
        environment,
        write: (line) => cliOutput.push(line),
        writeError: (line) => cliErrors.push(line),
      })).toBe(2);
      expect(cliOutput.length).toBeGreaterThan(0);
      expect(cliErrors.length).toBeGreaterThan(0);

      const thrown = await service.waitForRunStatus(chatRun.runId, "failed", 1)
        .then(() => "unexpected_success", (error: unknown) => String(error));
      expect(thrown).not.toBe("unexpected_success");
      expect(thrown.length).toBeGreaterThan(0);

      const backupPath = path.join(service.root, "composed-containment-backup");
      const backupResponse = await service.runRequest("/v1/backups", {
        method: "POST",
        body: JSON.stringify({ destination: backupPath }),
      });
      expect(backupResponse.status).toBe(201);
      httpJson.push(await backupResponse.text());

      const database = new DatabaseSync(service.databasePath, { readOnly: true });
      let keyId = "";
      let ciphertextHex = "";
      let ciphertextBase64 = "";
      let durableSurfaces = "";
      try {
        const secret = database.prepare(
          `SELECT key_id, ciphertext, hex(ciphertext) AS ciphertext_hex
           FROM managed_secret_versions`,
        ).get() as {
          key_id: string;
          ciphertext: Uint8Array;
          ciphertext_hex: string;
        };
        keyId = secret.key_id;
        ciphertextHex = secret.ciphertext_hex;
        ciphertextBase64 = Buffer.from(secret.ciphertext).toString("base64");
        const runEvents = database.prepare(
          `SELECT payload_json FROM run_events
           WHERE run_id IN (?, ?) ORDER BY run_id, sequence`,
        ).all(chatRun.runId, responsesRun.runId);
        const snapshots = database.prepare(
          "SELECT content_json FROM agent_revisions ORDER BY revision_id",
        ).all();
        const verifications = database.prepare(
          "SELECT * FROM model_verifications ORDER BY verification_id",
        ).all();
        const health = database.prepare(
          "SELECT * FROM provider_health ORDER BY health_id",
        ).all();
        const audit = database.prepare(
          "SELECT payload_json FROM model_registry_events ORDER BY event_id",
        ).all();
        expect(runEvents.length).toBeGreaterThan(0);
        expect(snapshots.length).toBeGreaterThan(0);
        expect(verifications.length).toBeGreaterThan(0);
        expect(health.length).toBeGreaterThan(0);
        expect(audit.length).toBeGreaterThan(0);
        durableSurfaces = JSON.stringify({ runEvents, snapshots, verifications, health, audit });
      } finally {
        database.close();
      }

      const backupDatabasePath = path.join(backupPath, "kernel.db");
      const backupDatabase = new DatabaseSync(backupDatabasePath, { readOnly: true });
      try {
        const backupSecret = backupDatabase.prepare(
          `SELECT key_id, hex(ciphertext) AS ciphertext_hex
           FROM managed_secret_versions`,
        ).get();
        expect(backupSecret).toEqual({
          key_id: keyId,
          ciphertext_hex: ciphertextHex,
        });
      } finally {
        backupDatabase.close();
      }

      const rawDatabaseFiles = await Promise.all(
        [service.databasePath, `${service.databasePath}-wal`, `${service.databasePath}-shm`]
          .filter(existsSync)
          .map((candidate) => readFile(candidate, "latin1")),
      );
      const backupDatabaseBytes = await readFile(backupDatabasePath, "latin1");
      const backupManifest = await readFile(path.join(backupPath, "manifest.json"), "utf8");
      expect(rawDatabaseFiles.length).toBeGreaterThan(0);
      expect(backupDatabaseBytes.length).toBeGreaterThan(0);
      expect(backupManifest.length).toBeGreaterThan(0);

      const emittedProviderBodies = (
        provider.rawResponseBodies
      );
      expect(emittedProviderBodies.join("\n")).toContain(rawReasoning);
      expect(emittedProviderBodies.join("\n")).toContain(rawResponsesReasoning);
      expect(emittedProviderBodies.join("\n")).toContain(rawProviderBody);
      expect(provider.chatRequests).toHaveLength(1);
      expect(provider.responsesRequests).toHaveLength(1);
      expect(provider.chatRequests[0]?.credentialMatched).toBe(true);

      expect(managedPlaintext.length).toBeGreaterThan(16);
      expect(rawReasoning.length).toBeGreaterThan(16);
      expect(rawResponsesReasoning.length).toBeGreaterThan(16);
      expect(rawProviderBody.length).toBeGreaterThan(16);
      expect(keyId.length).toBeGreaterThan(16);
      expect(ciphertextHex.length).toBeGreaterThan(16);
      expect(new Set([
        managedPlaintext,
        rawReasoning,
        rawResponsesReasoning,
        rawProviderBody,
        keyId,
        ciphertextHex,
      ]).size).toBe(6);

      const publicAndObservable = JSON.stringify({
        httpJson,
        sse,
        cliOutput,
        cliErrors,
        thrown,
        logs: service.logs,
        providerRequests: [...provider.chatRequests, ...provider.responsesRequests],
        setupResponseBodies,
        durableSurfaces,
        backupManifest,
      });
      const allDurableBytes = [
        publicAndObservable,
        ...rawDatabaseFiles,
        backupDatabaseBytes,
      ].join("\n");
      for (const forbidden of [
        managedPlaintext,
        rawReasoning,
        rawResponsesReasoning,
        rawProviderBody,
      ]) {
        expect(allDurableBytes).not.toContain(forbidden);
      }
      expect(publicAndObservable).not.toContain(keyId);
      for (const encodedCiphertext of [ciphertextHex, ciphertextBase64]) {
        expect(encodedCiphertext.length).toBeGreaterThan(16);
        expect(publicAndObservable.toLowerCase())
          .not.toContain(encodedCiphertext.toLowerCase());
      }
    } finally {
      await cleanup.dispose();
    }
  }, 35_000);

  it("keeps the active assignment byte-stable across verification, key, timeout, redirect, outage, and cancellation failures", async () => {
    const activeApiKey = "ACTIVE_API_KEY_ASSIGNMENT_MARKER";
    const rotatedApiKey = "ROTATED_API_KEY_ASSIGNMENT_MARKER";
    const rawProviderMarker = "RAW_PROVIDER_FAILURE_MARKER";
    const cleanup = createAsyncCleanupStack();

    try {
      const provider = cleanup.use(await FakeOpenAiProvider.start({
        models: ["active-chat-model", "failed-responses-model"],
        chat: [
        { type: "verification_text", text: "active verification passed" },
        { type: "verification_tool", callId: "verify-active-call" },
      ],
        responses: [{
        type: "error",
        status: 400,
        body: { error: { message: rawProviderMarker } },
      }, {
        type: "verification_text",
        text: "must exceed the provider request deadline",
        delayMs: 500,
      }, {
        type: "verification_text",
        text: "retry must also exceed the provider request deadline",
        delayMs: 500,
        }],
      }), (active) => active.close());
      const redirectTarget = cleanup.use(
        await FakeOpenAiProvider.start(),
        (active) => active.close(),
      );
      const redirectSource = cleanup.use(await FakeOpenAiProvider.start({
        models: ["redirect-responses-model"],
        responsesRedirectUrl: `${redirectTarget.baseUrl}/responses`,
      }), (active) => active.close());
      const service = cleanup.use(await startRealTestApp({
        verificationRequestTimeoutMs: 50,
      }), (active) => active.close());
      const active = await service.setupVerifiedModel({
        connectionSlug: "active-failure-proof",
        profileSlug: "active-failure-proof",
        providerBaseUrl: provider.baseUrl,
        modelId: "active-chat-model",
        protocol: "chat_completions",
        agentId: "primary",
        apiKey: activeApiKey,
      });
      const assignment = (): string => {
        const database = new DatabaseSync(service.databasePath, { readOnly: true });
        try {
          return JSON.stringify(database.prepare(
            "SELECT * FROM model_assignments WHERE agent_id = 'primary'",
          ).get());
        } finally {
          database.close();
        }
      };
      const frozenAssignment = assignment();

      const candidateConnection = await jsonRequest(service.adminRequest(
        "/provider-connections",
        {
          method: "POST",
          body: JSON.stringify({
            slug: "failed-candidate",
            displayName: "Failed Candidate",
            kind: "openai_compatible",
            baseUrl: provider.baseUrl,
            auth: { type: "none" },
            protocolPreference: "responses",
          }),
        },
      ), 201) as { connectionId: string; revisions: Array<{ revisionId: string }> };
      const candidateConnectionRevisionId = candidateConnection.revisions[0]!.revisionId;
      await jsonRequest(service.adminRequest(
        `/provider-connection-revisions/${candidateConnectionRevisionId}/discover`,
        { method: "POST", body: JSON.stringify({ expectedRevision: 0 }) },
      ), 200);
      const candidateProfile = await jsonRequest(service.adminRequest("/model-profiles", {
        method: "POST",
        body: JSON.stringify({
          slug: "failed-candidate",
          displayName: "Failed Candidate",
          connectionRevisionId: candidateConnectionRevisionId,
          modelId: "failed-responses-model",
          protocol: "responses",
          maxInputTokens: 32_768,
          contextWindowSource: "operator",
        }),
      }), 201) as { recordRevision: number; revisions: Array<{ revisionId: string }> };
      const candidateProfileRevisionId = candidateProfile.revisions[0]!.revisionId;
      const queued = await jsonRequest(service.adminRequest(
        `/model-profile-revisions/${candidateProfileRevisionId}/verifications`,
        {
          method: "POST",
          body: JSON.stringify({
            expectedRevision: candidateProfile.recordRevision,
            capabilityBaseline: "text_and_single_tool_call_v1",
          }),
        },
      ), 202) as { verificationId: string };
      const failedVerification = await waitForVerificationFailure(
        service,
        queued.verificationId,
      );
      expect(failedVerification).toMatchObject({
        status: "failed",
        resultCode: "model_protocol_error",
      });
      expect(JSON.stringify(failedVerification)).not.toContain(rawProviderMarker);
      expect(assignment()).toBe(frozenAssignment);

      const timeoutVerificationId = await queueCandidateVerification(service, {
        slug: "timeout-candidate",
        providerBaseUrl: provider.baseUrl,
        modelId: "failed-responses-model",
        protocol: "responses",
      });
      const timeoutFailure = await waitForVerificationFailure(service, timeoutVerificationId);
      expect(timeoutFailure).toMatchObject({
        status: "failed",
        resultCode: "provider_unavailable",
      });
      expect(assignment()).toBe(frozenAssignment);

      const redirectVerificationId = await queueCandidateVerification(service, {
        slug: "cross-origin-redirect-candidate",
        providerBaseUrl: redirectSource.baseUrl,
        modelId: "redirect-responses-model",
        protocol: "responses",
      });
      const redirectFailure = await waitForVerificationFailure(
        service,
        redirectVerificationId,
      );
      expect(redirectFailure).toMatchObject({
        status: "failed",
        resultCode: "provider_unavailable",
      });
      expect(redirectSource.responsesRequests.length).toBeGreaterThan(0);
      expect(redirectTarget.requests).toEqual([]);
      expect(redirectTarget.chatRequests).toEqual([]);
      expect(redirectTarget.responsesRequests).toEqual([]);
      expect(assignment()).toBe(frozenAssignment);

      const rotated = await jsonRequest(service.adminRequest(
        `/provider-connections/${active.connectionId}/revisions`,
        {
          method: "POST",
          body: JSON.stringify({
            expectedRevision: 2,
            displayName: "Active Failure Proof",
            baseUrl: provider.baseUrl,
            auth: { type: "api_key" },
            apiKey: rotatedApiKey,
            allowInsecureHttp: false,
            protocolPreference: "chat_completions",
          }),
        },
      ), 200);
      expect(JSON.stringify(rotated)).not.toContain(rotatedApiKey);
      expect(assignment()).toBe(frozenAssignment);

      await service.restart({ masterKey: Buffer.alloc(32, 0x7f).toString("base64") });
      const ready = await service.runRequest("/readyz");
      expect({ status: ready.status, body: await ready.json() }).toEqual({
        status: 200,
        body: { ready: true },
      });
      const locked = await service.runRequest("/v1/runs", {
        method: "POST",
        headers: { "idempotency-key": "wrong-master-key-run" },
        body: JSON.stringify({
          agentId: "primary",
          sessionKey: "failure:wrong-master-key",
          input: { type: "text", text: "must remain locked" },
        }),
      });
      expect(locked.status).toBe(503);
      expect(await locked.json()).toMatchObject({ code: "model_provider_locked" });
      expect(assignment()).toBe(frozenAssignment);
      await service.restart();

      provider.replaceChatTurns(Array.from({ length: 3 }, () => ({
        type: "error" as const,
        status: 500,
        body: { error: { message: rawProviderMarker } },
      })));
      const outage = await service.createRun({
        agentId: "primary",
        sessionKey: "failure:provider-outage",
        text: "fail without moving the assignment",
        idempotencyKey: "provider-outage-run",
      });
      await service.waitForRunStatus(outage.runId, "failed");
      expect(assignment()).toBe(frozenAssignment);

      provider.replaceChatTurns([{
        type: "text",
        text: "must be cancelled",
        delayMs: 5_000,
      }]);
      const cancellation = await service.createRun({
        agentId: "primary",
        sessionKey: "failure:cancellation",
        text: "cancel the delayed provider call",
        idempotencyKey: "provider-cancellation-run",
      });
      await service.waitForRunStatus(cancellation.runId, "running");
      await jsonRequest(service.runRequest(`/v1/runs/${cancellation.runId}/cancel`, {
        method: "POST",
      }), 200);
      await service.waitForRunStatus(cancellation.runId, "cancelled");
      expect(assignment()).toBe(frozenAssignment);
      expect(JSON.stringify({
        chat: provider.chatRequests,
        responses: provider.responsesRequests,
      }).includes(activeApiKey)).toBe(false);

      const failedRunResponse = await service.runRequest(`/v1/runs/${outage.runId}`);
      expect(failedRunResponse.status).toBe(200);
      const failedRunJson = await failedRunResponse.text();
      const failedRunEvents = JSON.stringify(await service.readRunEvents(outage.runId));
      const thrownError = await service.waitForRunStatus(outage.runId, "completed", 1)
        .then(() => "unexpected_success", (error: unknown) => String(error));
      const cliOutput: string[] = [];
      const cliErrors: string[] = [];
      expect(await executeCli(["providers", "list", "--json"], {
        environment: {
          MYAGENT_API_URL: service.url,
          MYAGENT_ADMIN_TOKEN: "admin-test-token",
        },
        write: (line) => cliOutput.push(line),
        writeError: (line) => cliErrors.push(line),
      })).toBe(0);
      const backupPath = path.join(service.root, "provider-failure-backup");
      const backupResponse = await service.runRequest("/v1/backups", {
        method: "POST",
        body: JSON.stringify({ destination: backupPath }),
      });
      expect(backupResponse.status).toBe(201);
      const backupOutput = [
        await backupResponse.text(),
        await readFile(path.join(backupPath, "kernel.db"), "latin1"),
        await readFile(path.join(backupPath, "manifest.json"), "utf8"),
      ];

      const database = new DatabaseSync(service.databasePath, { readOnly: true });
      try {
        const prohibited = JSON.stringify({
          http: failedRunJson,
          sse: failedRunEvents,
          cliOutput,
          cliErrors,
          thrownError,
          events: database.prepare("SELECT payload_json FROM run_events").all(),
          health: database.prepare("SELECT * FROM provider_health").all(),
          verifications: database.prepare("SELECT * FROM model_verifications").all(),
          audits: database.prepare("SELECT payload_json FROM model_registry_events").all(),
          snapshots: database.prepare("SELECT content_json FROM agent_revisions").all(),
          logs: service.logs,
          backupOutput,
        });
        expect(prohibited).not.toContain(rawProviderMarker);
      } finally {
        database.close();
      }
    } finally {
      await cleanup.dispose();
    }
  }, 35_000);
});

function captureGatewayUrl(capture: (url: string) => void): ProviderEgressGatewayListen {
  return async (server, address) => {
    await listen(server, address.host, address.port);
    const actual = server.address() as AddressInfo;
    capture(`http://${address.host}:${String(actual.port)}`);
  };
}

function captureGatewayTraffic(requestPaths: string[]): ProviderEgressGatewayListen {
  return async (server, address) => {
    server.on("request", (request) => {
      requestPaths.push(request.url ?? "");
    });
    await listen(server, address.host, address.port);
  };
}

async function listen(server: Server, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function jsonRequest(responsePromise: Promise<Response>, status: number): Promise<unknown> {
  const response = await responsePromise;
  expect(response.status).toBe(status);
  return response.status === 204 ? null : response.json();
}

function assignmentSnapshot(databasePath: string, agentId: string): string {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return JSON.stringify(database.prepare(
      "SELECT * FROM model_assignments WHERE agent_id = ?",
    ).get(agentId));
  } finally {
    database.close();
  }
}

function serviceRequest(
  serviceUrl: string,
  token: string,
  pathname: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${serviceUrl}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
}

async function waitForRunState(
  serviceUrl: string,
  runId: string,
  expected: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  while (true) {
    const response = await serviceRequest(
      serviceUrl,
      "run-test-token",
      `/v1/runs/${runId}`,
    );
    expect(response.status).toBe(200);
    const run = await response.json() as Record<string, unknown>;
    if (run.status === expected) return run;
    if (Date.now() >= deadline) throw new Error(`run_status_timeout:${String(run.status)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForVerificationFailure(
  service: Awaited<ReturnType<typeof startRealTestApp>>,
  verificationId: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  while (true) {
    const response = await service.adminRequest(`/model-verifications/${verificationId}`);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    if (["failed", "passed", "cancelled"].includes(String(body.status))) return body;
    if (Date.now() >= deadline) throw new Error(`verification_timeout:${String(body.status)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function queueCandidateVerification(
  service: Awaited<ReturnType<typeof startRealTestApp>>,
  input: {
    slug: string;
    providerBaseUrl: string;
    modelId: string;
    protocol: "chat_completions" | "responses";
  },
): Promise<string> {
  const connection = await jsonRequest(service.adminRequest(
    "/provider-connections",
    {
      method: "POST",
      body: JSON.stringify({
        slug: input.slug,
        displayName: input.slug,
        kind: "openai_compatible",
        baseUrl: input.providerBaseUrl,
        auth: { type: "none" },
        protocolPreference: input.protocol,
      }),
    },
  ), 201) as { revisions: Array<{ revisionId: string }> };
  const connectionRevisionId = connection.revisions[0]!.revisionId;
  await jsonRequest(service.adminRequest(
    `/provider-connection-revisions/${connectionRevisionId}/discover`,
    { method: "POST", body: JSON.stringify({ expectedRevision: 0 }) },
  ), 200);
  const profile = await jsonRequest(service.adminRequest("/model-profiles", {
    method: "POST",
    body: JSON.stringify({
      slug: input.slug,
      displayName: input.slug,
      connectionRevisionId,
      modelId: input.modelId,
      protocol: input.protocol,
      maxInputTokens: 32_768,
      contextWindowSource: "operator",
    }),
  }), 201) as { recordRevision: number; revisions: Array<{ revisionId: string }> };
  const queued = await jsonRequest(service.adminRequest(
    `/model-profile-revisions/${profile.revisions[0]!.revisionId}/verifications`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedRevision: profile.recordRevision,
        capabilityBaseline: "text_and_single_tool_call_v1",
      }),
    },
  ), 202) as { verificationId: string };
  return queued.verificationId;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
