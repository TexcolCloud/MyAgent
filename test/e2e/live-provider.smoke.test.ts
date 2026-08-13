import { readFile } from "node:fs/promises";

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { startRealTestApp } from "../helpers/start-test-app.js";

const deepseekResponsesModel = "deepseek-v4-flash";
const deepseekResponsesCandidate = "pi/deepseek:deepseek-v4-flash-responses";
const unsupportedDeepSeekModel = process.env.MYAGENT_DEEPSEEK_MODEL !== undefined &&
  process.env.MYAGENT_DEEPSEEK_MODEL !== deepseekResponsesModel;
const settings = smokeSettings();

it.skipIf(!unsupportedDeepSeekModel)("rejects unsupported DeepSeek variants before provider setup", () => {
  throw new Error("deepseek_responses_variant_requires_v4_flash");
});

describe.skipIf(settings === null)("live Pi DeepSeek provider smoke", () => {
  it("discovers, verifies, assigns, and completes one contained no-Tool Pi Run", async () => {
    if (settings === null) throw new Error("smoke_settings_missing");
    const secret = process.env.MYAGENT_DEEPSEEK_API_KEY;
    if (secret === undefined || secret.length === 0) throw new Error("smoke_api_key_missing");
    const service = await startRealTestApp();

    try {
      await service.setupVerifiedModel({
        connectionSlug: "deepseek-live",
        profileSlug: "deepseek-live",
        providerBaseUrl: settings.baseUrl,
        modelId: deepseekResponsesModel,
        protocol: "responses",
        driverId: "pi/deepseek",
        catalogCandidateId: deepseekResponsesCandidate,
        apiKeyEnvironment: settings.apiKeyEnvironment,
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
                    AS protocol,
                  json_extract(agent_revisions.content_json, '$.model.piRuntime.piVersion')
                    AS pi_version,
                  json_extract(agent_revisions.content_json, '$.model.piRuntime.driverId')
                    AS driver_id,
                  json_extract(agent_revisions.content_json, '$.model.piRuntime.providerCompatibilityContract')
                    AS provider_compatibility_contract
           FROM runs JOIN agent_revisions
             ON agent_revisions.revision_id = runs.agent_revision_id
           WHERE runs.run_id = ?`,
        ).get(run.runId)).toEqual({
          protocol: "pi_ai",
          pi_version: "0.73.1",
          driver_id: "pi/deepseek",
          provider_compatibility_contract: "deepseek-responses-v1",
        });
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

function smokeSettings(): {
  baseUrl: string;
  apiKeyEnvironment: "MYAGENT_DEEPSEEK_API_KEY";
} | null {
  const baseUrl = process.env.MYAGENT_DEEPSEEK_BASE_URL;
  const apiKey = process.env.MYAGENT_DEEPSEEK_API_KEY;
  if (unsupportedDeepSeekModel) return null;
  if (
    baseUrl === undefined || baseUrl.length === 0 ||
    apiKey === undefined || apiKey.length === 0
  ) return null;
  return {
    baseUrl,
    apiKeyEnvironment: "MYAGENT_DEEPSEEK_API_KEY",
  };
}
