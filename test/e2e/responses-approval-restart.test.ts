import { readFile } from "node:fs/promises";
import path from "node:path";

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { FakeOpenAiProvider } from "../helpers/fake-openai-provider.js";
import {
  createAsyncCleanupStack,
  startRealTestApp,
} from "../helpers/start-test-app.js";

describe("Responses Approval restart recovery", () => {
  it("preserves the provider call ID, executes once, and replays only committed SSE", async () => {
    const providerCallId = "responses-call-release-01";
    const effectFileName = "responses-approval-effect.log";
    const cleanup = createAsyncCleanupStack();

    try {
      const provider = cleanup.use(await FakeOpenAiProvider.start({
        models: ["responses-approval-model"],
        responses: [
        { type: "verification_text", text: "responses verification passed" },
        { type: "verification_tool", callId: "verify-responses-approval" },
        {
          type: "tool",
          callId: providerCallId,
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
        { type: "text", text: "approved Responses run completed" },
        ],
      }), (active) => active.close());
      const service = cleanup.use(await startRealTestApp(), (active) => active.close());
      await service.setupVerifiedModel({
        connectionSlug: "responses-approval",
        profileSlug: "responses-approval",
        providerBaseUrl: provider.baseUrl,
        modelId: "responses-approval-model",
        protocol: "responses",
        agentId: "primary",
      });
      provider.clearCapturedRequests();

      const run = await service.createRun({
        agentId: "primary",
        sessionKey: "responses:approval:restart",
        text: "Execute the requested side effect after Approval.",
        idempotencyKey: "responses-approval-restart-01",
      });
      const approvalEvent = await service.waitForRunEvent(run.runId, "approval.required");
      const pending = await service.onlyPendingApproval();
      expect(pending.runId).toBe(run.runId);
      expect(provider.responsesRequests).toHaveLength(1);
      expect(JSON.stringify(provider.responsesRequests[0])).not.toContain("previous_response_id");

      await service.stop();
      await service.restart();
      await service.approve(pending.approvalId);
      await service.waitForRunStatus(run.runId, "completed");
      const replay = await service.readRunEvents(run.runId, approvalEvent.sequence);

      expect(replay.length).toBeGreaterThan(0);
      expect(replay.every(({ sequence }) => sequence > approvalEvent.sequence)).toBe(true);
      expect(new Set(replay.map(({ sequence }) => sequence)).size).toBe(replay.length);
      expect(replay.map(({ type }) => type)).toContain("run.completed");
      expect(provider.responsesRequests).toHaveLength(2);
      const continuation = provider.responsesRequests[1]?.body as {
        input?: Array<Record<string, unknown>>;
      };
      expect(continuation).not.toHaveProperty("previous_response_id");
      expect(continuation.input).toContainEqual(expect.objectContaining({
        type: "function_call",
        call_id: providerCallId,
      }));
      expect(continuation.input).toContainEqual(expect.objectContaining({
        type: "function_call_output",
        call_id: providerCallId,
      }));
      expect(provider.responsesRequests.every((request) =>
        !("authorization" in request))).toBe(true);

      expect((await readFile(path.join(service.primaryWorkspace, effectFileName), "utf8")).trim())
        .toBe("executed");
      const database = new DatabaseSync(service.databasePath, { readOnly: true });
      try {
        const committedAfterCursor = database.prepare(
          `SELECT sequence, event_type, payload_json FROM run_events
           WHERE run_id = ? AND sequence > ? ORDER BY sequence`,
        ).all(run.runId, approvalEvent.sequence).map((row) => {
          const persisted = row as {
            sequence: number;
            event_type: string;
            payload_json: string;
          };
          return {
            sequence: persisted.sequence,
            type: persisted.event_type,
            payload: JSON.parse(persisted.payload_json) as Record<string, unknown>,
          };
        });
        expect(replay.map(({ sequence, type, payload }) => ({ sequence, type, payload })))
          .toEqual(committedAfterCursor);
        expect(database.prepare(
          `SELECT provider_call_id, state FROM tool_calls WHERE run_id = ?`,
        ).all(run.runId)).toEqual([{ provider_call_id: providerCallId, state: "succeeded" }]);
        expect(database.prepare(
          `SELECT COUNT(*) AS count FROM run_events
           WHERE run_id = ? AND event_type = 'tool.completed'`,
        ).get(run.runId)).toEqual({ count: 1 });
      } finally {
        database.close();
      }
    } finally {
      await cleanup.dispose();
    }
  }, 35_000);
});
