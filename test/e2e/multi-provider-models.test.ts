import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { executeCli } from "../../src/interfaces/cli/main.js";
import { FakeOpenAiProvider } from "../helpers/fake-openai-provider.js";
import { startRealTestApp } from "../helpers/start-test-app.js";

describe("multi-provider model registry release isolation", () => {
  it("honors the caller's Verification polling deadline", async () => {
    const provider = await FakeOpenAiProvider.start({
      models: ["slow-verification-model"],
      chat: [{
        type: "verification_text",
        text: "slow verification response",
        delayMs: 200,
      }],
    });
    const service = await startRealTestApp();

    try {
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
      await service.close();
      await provider.close();
    }
  }, 10_000);

  it("runs separate Chat and Responses profiles without Session, Tool, or provider-request leakage", async () => {
    const chatMarker = "CHAT_AGENT_REQUEST_MARKER";
    const responsesMarker = "RESPONSES_AGENT_REQUEST_MARKER";
    const provider = await FakeOpenAiProvider.start({
      models: ["chat-release-model", "responses-release-model"],
      chat: [
        { type: "verification_text", text: "chat verification passed" },
        { type: "verification_tool", callId: "verify-chat-call" },
        { type: "text", text: "chat agent completed" },
      ],
      responses: [
        { type: "verification_text", text: "responses verification passed" },
        { type: "verification_tool", callId: "verify-responses-call" },
        { type: "text", text: "responses agent completed" },
      ],
    });
    const service = await startRealTestApp();

    try {
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
        service.waitForRunStatus(chatRun.runId, "completed"),
        service.waitForRunStatus(responsesRun.runId, "completed"),
      ]);

      expect(provider.chatRequests).toHaveLength(1);
      expect(provider.responsesRequests).toHaveLength(1);
      const chatRequest = JSON.stringify(provider.chatRequests);
      const responsesRequest = JSON.stringify(provider.responsesRequests);
      expect(chatRequest).toContain(chatMarker);
      expect(chatRequest).not.toContain(responsesMarker);
      expect(responsesRequest).toContain(responsesMarker);
      expect(responsesRequest).not.toContain(chatMarker);
      expect(chatRequest).not.toContain("Researcher Agent");
      expect(responsesRequest).not.toContain("Primary Agent");
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
      await service.close();
      await provider.close();
    }
  }, 30_000);

  it("keeps the active assignment byte-stable across verification, key, timeout, redirect, outage, and cancellation failures", async () => {
    const activeApiKey = "ACTIVE_API_KEY_ASSIGNMENT_MARKER";
    const rotatedApiKey = "ROTATED_API_KEY_ASSIGNMENT_MARKER";
    const rawProviderMarker = "RAW_PROVIDER_FAILURE_MARKER";
    const provider = await FakeOpenAiProvider.start({
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
    });
    const redirectTarget = await FakeOpenAiProvider.start();
    const redirectSource = await FakeOpenAiProvider.start({
      models: ["redirect-responses-model"],
      responsesRedirectUrl: `${redirectTarget.baseUrl}/responses`,
    });
    const service = await startRealTestApp({
      verificationRequestTimeoutMs: 50,
    });

    try {
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
        resultCode: "model_protocol_error",
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
      await service.close();
      await provider.close();
      await redirectSource.close();
      await redirectTarget.close();
    }
  }, 35_000);
});

async function jsonRequest(responsePromise: Promise<Response>, status: number): Promise<unknown> {
  const response = await responsePromise;
  expect(response.status).toBe(status);
  return response.status === 204 ? null : response.json();
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
