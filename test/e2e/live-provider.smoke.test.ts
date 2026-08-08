import { readFile, writeFile } from "node:fs/promises";

import { DatabaseSync } from "node:sqlite";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";

import { bootstrap } from "../../src/bootstrap.js";
import {
  AgentHttpClient,
  prepareE2eFixture,
} from "../helpers/fault-controller.js";

const settings = smokeSettings();

describe.skipIf(settings === null)("live provider smoke", () => {
  it("completes one no-Tool Run with usage and no Secret leakage", async () => {
    if (settings === null) throw new Error("smoke_settings_missing");
    const secret = process.env[settings.apiKeyEnvironment];
    if (secret === undefined || secret.length === 0) {
      throw new Error("smoke_api_key_missing");
    }
    const fixture = await prepareE2eFixture(settings.baseUrl);
    const config = parseYaml(await readFile(fixture.configPath, "utf8")) as {
      models: Record<string, {
        model: string;
        baseUrl: string;
        apiKey: { fromEnvironment: string };
      }>;
    };
    const model = config.models.default;
    if (model === undefined) throw new Error("default_model_missing");
    model.model = settings.model;
    model.baseUrl = settings.baseUrl;
    model.apiKey = { fromEnvironment: settings.apiKeyEnvironment };
    await writeFile(fixture.configPath, stringifyYaml(config), "utf8");

    const logs: string[] = [];
    const service = await bootstrap(fixture.configPath, {
      listen: { host: "127.0.0.1", port: 0 },
      signals: false,
      log: { write: (line) => logs.push(line) },
    });
    const client = new AgentHttpClient(() => service.url);
    try {
      const run = await client.createRun({
        agentId: "primary",
        sessionKey: "smoke:live-provider",
        text: "Reply with a short plain-text greeting. Do not call any Tool.",
        idempotencyKey: "smoke-live-provider-0001",
      });
      await client.waitForStatus(run.runId, "completed", 60_000);
      const events = await client.readEventStream(run.runId);
      const completed = events.find((event) => event.type === "message.completed");
      expect(completed?.payload).toMatchObject({
        usage: {
          inputTokens: expect.any(Number),
          outputTokens: expect.any(Number),
        },
      });

      const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
      try {
        expect(database.prepare(
          "SELECT COUNT(*) AS count FROM tool_calls WHERE run_id = ?",
        ).get(run.runId)).toEqual({ count: 0 });
      } finally {
        database.close();
      }
      expect(JSON.stringify({ events, logs })).not.toContain(secret);
      expect((await readFile(fixture.databasePath)).includes(Buffer.from(secret))).toBe(false);
    } finally {
      await service.shutdown();
      await fixture.cleanup();
    }
  }, 90_000);
});

function smokeSettings(): {
  model: string;
  baseUrl: string;
  apiKeyEnvironment: string;
} | null {
  const model = process.env.MYAGENT_SMOKE_MODEL;
  const baseUrl = process.env.MYAGENT_SMOKE_BASE_URL;
  const apiKeyEnvironment = process.env.MYAGENT_SMOKE_API_KEY_ENV;
  if (
    model === undefined || model.length === 0 ||
    baseUrl === undefined || baseUrl.length === 0 ||
    apiKeyEnvironment === undefined || apiKeyEnvironment.length === 0 ||
    process.env[apiKeyEnvironment] === undefined
  ) {
    return null;
  }
  return { model, baseUrl, apiKeyEnvironment };
}
