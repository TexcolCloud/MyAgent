import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { describe, expect, it, vi } from "vitest";

import { bootstrap } from "../../src/bootstrap.js";
import { createHttpApp } from "../../src/interfaces/http/app.js";

const VALID_FIXTURE = fileURLToPath(new URL("../fixtures/config/valid", import.meta.url));

describe("readiness", () => {
  it("returns boolean-only health and readiness responses", async () => {
    let ready = true;
    const readiness = vi.fn(() => ready);
    const app = createHttpApp({ bearerToken: "test-token", readiness });
    try {
      const health = await app.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ ok: true });

      const available = await app.inject({ method: "GET", url: "/readyz" });
      expect(available.statusCode).toBe(200);
      expect(available.json()).toEqual({ ready: true });

      ready = false;
      const unavailable = await app.inject({ method: "GET", url: "/readyz" });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toEqual({ ready: false });
    } finally {
      await app.close();
    }
  });

  it("fails readiness while SQLite is locked or migration history is incomplete", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "myagent-readiness-"));
    const configRoot = path.join(root, "config");
    await cp(VALID_FIXTURE, configRoot, { recursive: true });
    const configPath = path.join(configRoot, "myagent.yaml");
    const config = parseYaml(await readFile(configPath, "utf8")) as {
      database: { busyTimeoutMs?: number };
    };
    config.database.busyTimeoutMs = 25;
    await writeFile(configPath, stringifyYaml(config));

    const previousBearer = process.env.MYAGENT_BEARER_TOKEN;
    const previousModel = process.env.MODEL_API_KEY;
    process.env.MYAGENT_BEARER_TOKEN = "readiness-operator-secret";
    process.env.MODEL_API_KEY = "readiness-provider-secret";
    let service: Awaited<ReturnType<typeof bootstrap>> | undefined;
    let blocker: DatabaseSync | undefined;
    let locked = false;
    try {
      service = await bootstrap(configPath, {
        listen: { host: "127.0.0.1", port: 0 },
        signals: false,
        log: { write: () => {} },
      });
      expect(await readReady(service.url)).toEqual({ status: 200, body: { ready: true } });

      blocker = new DatabaseSync(path.join(configRoot, "data", "kernel.db"));
      blocker.exec("PRAGMA busy_timeout = 25");
      blocker.exec("BEGIN IMMEDIATE");
      locked = true;
      expect(await readReady(service.url)).toEqual({ status: 503, body: { ready: false } });
      blocker.exec("ROLLBACK");
      locked = false;

      expect(await readReady(service.url)).toEqual({ status: 200, body: { ready: true } });
      blocker.exec("DELETE FROM schema_migrations");
      expect(await readReady(service.url)).toEqual({ status: 503, body: { ready: false } });
    } finally {
      if (locked) blocker?.exec("ROLLBACK");
      blocker?.close();
      await service?.shutdown();
      restoreEnvironment("MYAGENT_BEARER_TOKEN", previousBearer);
      restoreEnvironment("MODEL_API_KEY", previousModel);
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function readReady(baseUrl: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}/readyz`);
  return { status: response.status, body: await response.json() };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
