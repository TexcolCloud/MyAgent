import { readFile } from "node:fs/promises";

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { startRealTestApp } from "../helpers/start-test-app.js";

const settings = smokeSettings();

describe.skipIf(settings === null)("live DeepSeek provider smoke", () => {
  it("discovers, verifies, assigns, and completes one contained no-Tool Responses Run", async () => {
    if (settings === null) throw new Error("smoke_settings_missing");
    const secret = process.env.MYAGENT_DEEPSEEK_API_KEY;
    if (secret === undefined || secret.length === 0) throw new Error("smoke_api_key_missing");
    const service = await startRealTestApp();

    try {
      await service.setupVerifiedModel({
        connectionSlug: "deepseek-live",
        profileSlug: "deepseek-live",
        providerBaseUrl: settings.baseUrl,
        modelId: settings.model,
        protocol: "responses",
        providerKind: "deepseek",
        apiKeyEnvironment: "MYAGENT_DEEPSEEK_API_KEY",
        agentId: "primary",
        verificationTimeoutMs: 120_000,
      });
      const run = await service.createRun({
        agentId: "primary",
        sessionKey: "smoke:deepseek-live",
        text: "Reply with a short plain-text greeting. Do not call any Tool.",
        idempotencyKey: "smoke-deepseek-live-0001",
      });
      await service.waitForRunStatus(run.runId, "completed", 60_000);
      const events = await service.readRunEvents(run.runId);
      expect(events.map(({ type }) => type)).toContain("run.completed");
      expect(events.map(({ type }) => type)).toContain("message.completed");

      const database = new DatabaseSync(service.databasePath, { readOnly: true });
      try {
        expect(database.prepare(
          "SELECT COUNT(*) AS count FROM tool_calls WHERE run_id = ?",
        ).get(run.runId)).toEqual({ count: 0 });
        expect(database.prepare(
          `SELECT json_extract(agent_revisions.content_json, '$.model.invocationProtocol')
                    AS protocol
           FROM runs JOIN agent_revisions
             ON agent_revisions.revision_id = runs.agent_revision_id
           WHERE runs.run_id = ?`,
        ).get(run.runId)).toEqual({ protocol: "responses" });
      } finally {
        database.close();
      }
      const leakedToEventsOrLogs = JSON.stringify({ events, logs: service.logs }).includes(secret);
      expect(leakedToEventsOrLogs).toBe(false);
      expect((await readFile(service.databasePath)).includes(Buffer.from(secret))).toBe(false);
    } finally {
      await service.close();
    }
  }, 210_000);
});

function smokeSettings(): { model: string; baseUrl: string } | null {
  const baseUrl = process.env.MYAGENT_DEEPSEEK_BASE_URL;
  const apiKey = process.env.MYAGENT_DEEPSEEK_API_KEY;
  if (
    baseUrl === undefined || baseUrl.length === 0 ||
    apiKey === undefined || apiKey.length === 0
  ) return null;
  return {
    baseUrl,
    model: process.env.MYAGENT_DEEPSEEK_MODEL || "deepseek-v4-flash",
  };
}
