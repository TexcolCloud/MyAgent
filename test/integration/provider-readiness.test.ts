import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { openDatabase } from "../../src/adapters/sqlite/database.js";
import { SqliteEncryptedSecretStore } from "../../src/adapters/sqlite/encrypted-secret-store.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { SqliteModelRegistryRepository } from "../../src/adapters/sqlite/model-registry-repository.js";
import { bootstrap } from "../../src/bootstrap.js";
import {
  managedSecretVersionIdFromUuid,
  parseAgentId,
  providerConnectionRevisionIdFromUuid,
} from "../../src/domain/ids.js";
import { seedVerifiedChatAssignments } from "../helpers/verified-chat-model-registry.js";

const VALID_FIXTURE = fileURLToPath(new URL("../fixtures/config/valid", import.meta.url));
const ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
const WRONG_KEY = Buffer.alloc(32, 18).toString("base64");

describe("provider readiness", () => {
  it.each([
    { name: "missing", configuredKey: undefined },
    { name: "mismatched", configuredKey: WRONG_KEY },
  ])(
    "keeps local readiness true when the managed provider key is $name",
    async ({ name, configuredKey }) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `myagent-provider-${name}-`));
      const configRoot = path.join(root, "config");
      const configPath = path.join(configRoot, "myagent.yaml");
      const databasePath = path.join(configRoot, "data", "kernel.db");
      await cp(VALID_FIXTURE, configRoot, { recursive: true });
      await mkdir(path.dirname(databasePath), { recursive: true });

      const secretVersionId = managedSecretVersionIdFromUuid(
        `provider-readiness-${name}`,
      );
      const seeded = openDatabase({ path: databasePath, busyTimeoutMs: 5_000 });
      try {
        migrate(seeded.db);
        new SqliteEncryptedSecretStore(seeded.db, {
          MYAGENT_MASTER_KEY: ENCRYPTION_KEY,
        }).createVersion({
          versionId: secretVersionId,
          secretId: "provider-readiness-key",
          purpose: "provider_api_key",
          plaintext: "provider-readiness-plaintext",
          now: new Date("2026-08-09T00:00:00.000Z"),
        });
        const registry = new SqliteModelRegistryRepository(seeded.db);
        seedVerifiedChatAssignments(registry, [parseAgentId("primary")], {
          providerAuth: {
            type: "bearer",
            secret: { managedSecretVersionId: secretVersionId },
          },
        });
        registry.recordProviderHealth({
          connectionRevisionId: providerConnectionRevisionIdFromUuid("test-chat"),
          outcome: "failure",
          code: "provider_unavailable",
          traceId: "provider-readiness-health",
          observedAt: new Date("2026-08-09T00:01:00.000Z"),
        });
      } finally {
        seeded.close();
      }

      const previousBearer = process.env.MYAGENT_BEARER_TOKEN;
      const previousAdmin = process.env.MYAGENT_ADMIN_TOKEN;
      const previousMaster = process.env.MYAGENT_MASTER_KEY;
      const previousPreviousMaster = process.env.MYAGENT_PREVIOUS_MASTER_KEY;
      process.env.MYAGENT_BEARER_TOKEN = "provider-readiness-run-token";
      process.env.MYAGENT_ADMIN_TOKEN = "provider-readiness-admin-token";
      setEnvironment("MYAGENT_MASTER_KEY", configuredKey);
      delete process.env.MYAGENT_PREVIOUS_MASTER_KEY;
      let service: Awaited<ReturnType<typeof bootstrap>> | undefined;
      try {
        service = await bootstrap(configPath, {
          listen: { host: "127.0.0.1", port: 0 },
          signals: false,
          log: { write: () => {} },
        });
        expect(await readReady(service.url)).toEqual({
          status: 200,
          body: { ready: true },
        });

        const run = await fetch(`${service.url}/v1/runs`, {
          method: "POST",
          headers: {
            authorization: "Bearer provider-readiness-run-token",
            "content-type": "application/json",
            "idempotency-key": `provider-readiness-${name}`,
          },
          body: JSON.stringify({
            agentId: "primary",
            sessionKey: `provider-readiness:${name}`,
            input: { type: "text", text: "must remain locally ready" },
          }),
        });
        expect(run.status).toBe(503);
        expect(await run.json()).toMatchObject({ code: "model_provider_locked" });
        expect(await readReady(service.url)).toEqual({
          status: 200,
          body: { ready: true },
        });
      } finally {
        await service?.shutdown();
        restoreEnvironment("MYAGENT_BEARER_TOKEN", previousBearer);
        restoreEnvironment("MYAGENT_ADMIN_TOKEN", previousAdmin);
        restoreEnvironment("MYAGENT_MASTER_KEY", previousMaster);
        restoreEnvironment("MYAGENT_PREVIOUS_MASTER_KEY", previousPreviousMaster);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

async function readReady(baseUrl: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}/readyz`);
  return { status: response.status, body: await response.json() };
}

function setEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  setEnvironment(name, value);
}
