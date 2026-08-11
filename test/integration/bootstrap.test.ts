import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { openDatabase } from "../../src/adapters/sqlite/database.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { SqliteModelRegistryRepository } from "../../src/adapters/sqlite/model-registry-repository.js";
import { bootstrap } from "../../src/bootstrap.js";
import {
  modelRegistryEventIdFromUuid,
  parseModelProfileId,
} from "../../src/domain/ids.js";
import { seedVerifiedChatAssignments } from "../helpers/verified-chat-model-registry.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/config", import.meta.url));

describe("bootstrap", () => {
  it("fails on a missing Admin Token before creating or migrating SQLite", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "myagent-bootstrap-admin-"));
    const configRoot = path.join(root, "config");
    await cp(path.join(FIXTURES, "valid"), configRoot, { recursive: true });
    const previousBearer = process.env.MYAGENT_BEARER_TOKEN;
    const previousAdmin = process.env.MYAGENT_ADMIN_TOKEN;
    process.env.MYAGENT_BEARER_TOKEN = "bootstrap-run-token";
    delete process.env.MYAGENT_ADMIN_TOKEN;
    let service: Awaited<ReturnType<typeof bootstrap>> | undefined;
    let error: unknown;
    try {
      try {
        service = await bootstrap(path.join(configRoot, "myagent.yaml"), {
          listen: { host: "127.0.0.1", port: 0 },
          signals: false,
          log: { write: () => {} },
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: "secret_locked" });
      expect(await exists(path.join(configRoot, "data", "kernel.db"))).toBe(false);
    } finally {
      await service?.shutdown();
      restoreEnvironment("MYAGENT_BEARER_TOKEN", previousBearer);
      restoreEnvironment("MYAGENT_ADMIN_TOKEN", previousAdmin);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts without resolving an unassigned provider secret", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "myagent-bootstrap-secret-"));
    await cp(path.join(FIXTURES, "valid"), path.join(root, "config"), { recursive: true });
    const previousBearer = process.env.MYAGENT_BEARER_TOKEN;
    const previousAdmin = process.env.MYAGENT_ADMIN_TOKEN;
    const previousModel = process.env.MODEL_API_KEY;
    process.env.MYAGENT_BEARER_TOKEN = "bootstrap-token";
    process.env.MYAGENT_ADMIN_TOKEN = "bootstrap-admin-token";
    delete process.env.MODEL_API_KEY;
    let service: Awaited<ReturnType<typeof bootstrap>> | undefined;
    try {
      service = await bootstrap(path.join(root, "config", "myagent.yaml"), {
        listen: { host: "127.0.0.1", port: 0 },
        signals: false,
        log: { write: () => {} },
      });
      expect((await fetch(`${service.url}/healthz`)).status).toBe(200);
    } finally {
      await service?.shutdown();
      restoreEnvironment("MYAGENT_BEARER_TOKEN", previousBearer);
      restoreEnvironment("MYAGENT_ADMIN_TOKEN", previousAdmin);
      restoreEnvironment("MODEL_API_KEY", previousModel);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("synchronizes default assignments before initial and reloaded Catalogs become visible", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "myagent-bootstrap-sync-"));
    const configRoot = path.join(root, "config");
    const configPath = path.join(configRoot, "myagent.yaml");
    const databasePath = path.join(configRoot, "data", "kernel.db");
    await cp(path.join(FIXTURES, "valid"), configRoot, { recursive: true });
    await mkdir(path.dirname(databasePath), { recursive: true });
    const seed = openDatabase({ path: databasePath, busyTimeoutMs: 5_000 });
    try {
      migrate(seed.db);
      const registry = new SqliteModelRegistryRepository(seed.db);
      seedVerifiedChatAssignments(registry, []);
      registry.setDefaultProfile({
        profileId: parseModelProfileId("test-chat"),
        expectedRevision: 0,
        eventId: modelRegistryEventIdFromUuid("bootstrap-default"),
        traceId: "bootstrap-default",
        now: new Date("2026-08-09T00:00:00.000Z"),
      });
    } finally {
      seed.close();
    }

    const previousBearer = process.env.MYAGENT_BEARER_TOKEN;
    const previousAdmin = process.env.MYAGENT_ADMIN_TOKEN;
    process.env.MYAGENT_BEARER_TOKEN = "bootstrap-sync-token";
    process.env.MYAGENT_ADMIN_TOKEN = "bootstrap-sync-admin-token";
    let service: Awaited<ReturnType<typeof bootstrap>> | undefined;
    try {
      service = await bootstrap(configPath, {
        listen: { host: "127.0.0.1", port: 0 },
        signals: false,
        log: { write: () => {} },
      });
      expect(readAssignments(databasePath)).toEqual([
        { agent_id: "primary", source: "default" },
        { agent_id: "researcher", source: "default" },
      ]);

      const newAgentRoot = path.join(configRoot, "agents", "newcomer");
      await cp(path.join(configRoot, "agents", "researcher"), newAgentRoot, {
        recursive: true,
      });
      const agentPath = path.join(newAgentRoot, "agent.yaml");
      await writeFile(
        agentPath,
        (await readFile(agentPath, "utf8"))
          .replace("id: researcher", "id: newcomer")
          .replace("displayName: Researcher", "displayName: Newcomer"),
      );

      const response = await fetch(`${service.url}/v1/config/reload`, {
        method: "POST",
        headers: { authorization: "Bearer bootstrap-sync-token" },
      });
      expect(response.status).toBe(200);
      expect(readAssignments(databasePath)).toEqual([
        { agent_id: "newcomer", source: "default" },
        { agent_id: "primary", source: "default" },
        { agent_id: "researcher", source: "default" },
      ]);
    } finally {
      await service?.shutdown();
      restoreEnvironment("MYAGENT_BEARER_TOKEN", previousBearer);
      restoreEnvironment("MYAGENT_ADMIN_TOKEN", previousAdmin);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads configuration before listening and closes all resources on shutdown", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "myagent-bootstrap-"));
    await cp(path.join(FIXTURES, "valid"), path.join(root, "config"), { recursive: true });
    const previousBearer = process.env.MYAGENT_BEARER_TOKEN;
    const previousAdmin = process.env.MYAGENT_ADMIN_TOKEN;
    const previousModel = process.env.MODEL_API_KEY;
    process.env.MYAGENT_BEARER_TOKEN = "bootstrap-token";
    process.env.MYAGENT_ADMIN_TOKEN = "bootstrap-admin-token";
    process.env.MODEL_API_KEY = "model-token";
    let service: Awaited<ReturnType<typeof bootstrap>> | undefined;
    const sigintListeners = process.listenerCount("SIGINT");
    const sigtermListeners = process.listenerCount("SIGTERM");

    try {
      service = await bootstrap(path.join(root, "config", "myagent.yaml"), {
        listen: { host: "127.0.0.1", port: 0 },
        log: { write: () => {} },
      });
      expect(process.listenerCount("SIGINT")).toBe(sigintListeners + 1);
      expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners + 1);
      const response = await fetch(`${service.url}/healthz`);
      expect(response.status).toBe(200);
    } finally {
      await service?.shutdown();
      restoreEnvironment("MYAGENT_BEARER_TOKEN", previousBearer);
      restoreEnvironment("MYAGENT_ADMIN_TOKEN", previousAdmin);
      restoreEnvironment("MODEL_API_KEY", previousModel);
      await rm(root, { recursive: true, force: true });
    }
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
  });
});

async function exists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function readAssignments(databasePath: string): Array<{
  agent_id: string;
  source: string;
}> {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(
      "SELECT agent_id, source FROM model_assignments ORDER BY agent_id",
    ).all() as unknown as Array<{ agent_id: string; source: string }>;
  } finally {
    database.close();
  }
}
