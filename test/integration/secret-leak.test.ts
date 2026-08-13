import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { bootstrap } from "../../src/bootstrap.js";
import { SqliteModelRegistryRepository } from "../../src/adapters/sqlite/model-registry-repository.js";
import { openDatabase } from "../../src/adapters/sqlite/database.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { parseAgentId } from "../../src/domain/ids.js";
import { seedVerifiedChatAssignments } from "../helpers/verified-chat-model-registry.js";

const VALID_FIXTURE = fileURLToPath(new URL("../fixtures/config/valid", import.meta.url));
const OPERATOR_SECRET = "operator-secret-seeded";
const ADMIN_SECRET = "admin-secret-seeded";
const PROVIDER_SECRET = "provider-secret-seeded";

describe("Secret containment", () => {
  it("redacts injected bootstrap authentication from startup, auth failure, and shutdown logs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "myagent-bootstrap-auth-logs-"));
    const configRoot = path.join(root, "config");
    await cp(VALID_FIXTURE, configRoot, { recursive: true });
    const logs: string[] = [];
    const auth = { bearerToken: "local-run-secret", adminToken: "local-admin-secret" };
    let service: Awaited<ReturnType<typeof bootstrap>> | undefined;

    try {
      service = await bootstrap(path.join(configRoot, "myagent.yaml"), {
        auth,
        listen: { host: "127.0.0.1", port: 0 },
        signals: false,
        log: { write: (line) => { logs.push(line); } },
      });
      const response = await fetch(`${service.url}/v1/agents`, {
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(response.status).toBe(401);
      await service.shutdown();

      const events = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ level: "info", message: expect.stringContaining("Server listening") }),
      ]));
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ level: "warn", code: "unauthorized" }),
      ]));
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ level: "info", code: "service_stopped" }),
      ]));
      expect(logs.join("\n")).not.toContain(auth.bearerToken);
      expect(logs.join("\n")).not.toContain(auth.adminToken);
    } finally {
      await service?.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps resolved Secrets out of logs, HTTP, events, and revision snapshots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "myagent-secret-leak-"));
    const configRoot = path.join(root, "config");
    await cp(VALID_FIXTURE, configRoot, { recursive: true });
    const configPath = path.join(configRoot, "myagent.yaml");
    const databasePath = path.join(configRoot, "data", "kernel.db");
    const previousBearer = process.env.MYAGENT_BEARER_TOKEN;
    const previousAdmin = process.env.MYAGENT_ADMIN_TOKEN;
    const previousModel = process.env.MODEL_API_KEY;
    process.env.MYAGENT_BEARER_TOKEN = OPERATOR_SECRET;
    process.env.MYAGENT_ADMIN_TOKEN = ADMIN_SECRET;
    process.env.MODEL_API_KEY = PROVIDER_SECRET;
    const logs: string[] = [];
    const responses: string[] = [];
    let service: Awaited<ReturnType<typeof bootstrap>> | undefined;

    try {
      await mkdir(path.dirname(databasePath), { recursive: true });
      const connection = openDatabase({ path: databasePath, busyTimeoutMs: 5_000 });
      try {
        migrate(connection.db);
        seedVerifiedChatAssignments(
          new SqliteModelRegistryRepository(connection.db),
          [parseAgentId("primary")],
          { providerAuth: { type: "bearer", secret: { fromEnvironment: "MODEL_API_KEY" } } },
        );
      } finally {
        connection.close();
      }
      service = await bootstrap(configPath, {
        listen: { host: "127.0.0.1", port: 0 },
        signals: false,
        log: { write: (line) => { logs.push(line); } },
      });
      const created = await fetch(`${service.url}/v1/runs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${OPERATOR_SECRET}`,
          "content-type": "application/json",
          "idempotency-key": "secret-leak-request-0001",
        },
        body: JSON.stringify({
          agentId: "primary",
          sessionKey: "secret:leak",
          input: { type: "text", text: "safe input" },
        }),
      });
      responses.push(await created.text());
      expect(created.status).toBe(202);

      const failed = await fetch(`${service.url}/v1/backups`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${OPERATOR_SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          destination: path.join(root, "missing", PROVIDER_SECRET, "backup"),
        }),
      });
      responses.push(await failed.text());
      expect(failed.status).toBe(500);
      await service.shutdown();

      const database = new DatabaseSync(databasePath, { readOnly: true });
      let persisted: string;
      try {
        persisted = JSON.stringify({
          revisions: database.prepare("SELECT content_json FROM agent_revisions").all(),
          events: database.prepare("SELECT payload_json FROM run_events").all(),
        });
      } finally {
        database.close();
      }
      const rawDatabase = (await readFile(databasePath)).toString("latin1");
      const captured = [...logs, ...responses, persisted, rawDatabase].join("\n");
      expect(logs.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "internal_error", traceId: expect.any(String) })]),
      );
      expect(captured).not.toContain(OPERATOR_SECRET);
      expect(captured).not.toContain(ADMIN_SECRET);
      expect(captured).not.toContain(PROVIDER_SECRET);
      expect(captured).not.toContain(path.join(root, "missing"));
    } finally {
      await service?.shutdown();
      restoreEnvironment("MYAGENT_BEARER_TOKEN", previousBearer);
      restoreEnvironment("MYAGENT_ADMIN_TOKEN", previousAdmin);
      restoreEnvironment("MODEL_API_KEY", previousModel);
      await rm(root, { recursive: true, force: true });
    }
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
