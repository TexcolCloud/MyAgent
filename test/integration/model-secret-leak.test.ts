import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createStructuredLogger } from "../../src/observability/logger.js";
import { startTestApp } from "../helpers/start-test-app.js";
import { tempPath } from "../helpers/temp-dir.js";

describe("Model control Secret containment", () => {
  it("keeps submitted Provider API keys out of HTTP, logs, events, and database plaintext", async () => {
    const plaintext = "needle-provider-api-key-13";
    const databasePath = tempPath("http-model-secret-leak.db");
    const logs: string[] = [];
    const harness = await startTestApp({
      databasePath,
      logger: createStructuredLogger({ write: (line) => { logs.push(line); } }),
    });
    const responses: string[] = [];
    let persistedRows = "";
    try {
      const request = {
        method: "POST" as const,
        url: "/v1/admin/provider-connections",
        remoteAddress: "127.0.0.1",
        headers: { authorization: "Bearer test-admin-token" },
        payload: {
          slug: "leak-provider",
          displayName: "Leak Provider",
          kind: "openai",
          auth: { type: "api_key" },
          apiKey: plaintext,
        },
      };
      const created = await harness.app.inject(request);
      responses.push(created.payload);
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        credentialConfigured: true,
        secretVersionId: expect.any(String),
      });

      const duplicate = await harness.app.inject(request);
      responses.push(duplicate.payload);
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toMatchObject({
        code: "resource_conflict",
        traceId: expect.any(String),
      });

      persistedRows = JSON.stringify({
        connections: harness.connection.db.prepare(
          "SELECT auth_json FROM provider_connection_revisions",
        ).all(),
        events: harness.connection.db.prepare(
          "SELECT payload_json FROM model_registry_events",
        ).all(),
        secrets: harness.connection.db.prepare(
          `SELECT secret_id, key_id, hex(ciphertext) AS ciphertext,
                  hex(nonce) AS nonce, hex(authentication_tag) AS authentication_tag
           FROM managed_secret_versions`,
        ).all(),
      });
    } finally {
      await harness.close();
    }

    const databaseFiles = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
      .filter(existsSync)
      .map((path) => readFileSync(path).toString("latin1"));
    const captured = [...responses, ...logs, persistedRows, ...databaseFiles].join("\n");
    expect(logs.every((line) => typeof JSON.parse(line) === "object")).toBe(true);
    expect(captured).not.toContain(plaintext);
  });
});
