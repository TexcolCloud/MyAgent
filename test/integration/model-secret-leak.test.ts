import { existsSync, readFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import {
  openDatabase,
  withImmediateTransaction,
} from "../../src/adapters/sqlite/database.js";
import { SqliteEncryptedSecretStore } from "../../src/adapters/sqlite/encrypted-secret-store.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { ManageSecretsService } from "../../src/application/manage-secrets.js";
import { managedSecretVersionIdFromUuid } from "../../src/domain/ids.js";
import {
  createHttpApp,
  type ModelControlServices,
} from "../../src/interfaces/http/app.js";
import { createStructuredLogger } from "../../src/observability/logger.js";
import { executeCli } from "../../src/interfaces/cli/main.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { startTestApp } from "../helpers/start-test-app.js";
import { tempPath } from "../helpers/temp-dir.js";

describe("Model control Secret containment", () => {
  it("keeps submitted Provider API keys out of HTTP, logs, events, and database plaintext", async () => {
    const plaintext = "needle-provider-api-key-13";
    const databasePath = tempPath("http-model-secret-leak.db");
    const backupPath = tempPath("http-model-secret-leak-backup");
    const logs: string[] = [];
    const harness = await startTestApp({
      databasePath,
      logger: createStructuredLogger({ write: (line) => { logs.push(line); } }),
    });
    const responses: string[] = [];
    const cliOutput: string[] = [];
    const cliErrors: string[] = [];
    let prohibitedDurableSurfaces = "";
    let secretMetadata: Array<{ key_id: string; ciphertext: string }> = [];
    try {
      const request = {
        method: "POST" as const,
        url: "/v1/admin/provider-connections",
        remoteAddress: "127.0.0.1",
        headers: { authorization: "Bearer test-admin-token" },
        payload: {
          slug: "leak-provider",
          displayName: "Leak Provider",
          kind: "openai_compatible",
          baseUrl: "https://api.openai.com/v1",
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
      const createdBody = created.json() as {
        revisions: Array<{ revisionId: string }>;
      };
      const connectionRevisionId = createdBody.revisions[0]!.revisionId;

      const duplicate = await harness.app.inject(request);
      responses.push(duplicate.payload);
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toMatchObject({
        code: "resource_conflict",
        traceId: expect.any(String),
      });

      for (const url of ["/healthz", "/readyz", "/v1/admin/provider-connections"]) {
        const observed = await harness.app.inject({
          method: "GET",
          url,
          remoteAddress: "127.0.0.1",
          headers: url.startsWith("/v1/admin")
            ? { authorization: "Bearer test-admin-token" }
            : {},
        });
        responses.push(observed.payload);
        expect(observed.statusCode).toBe(200);
      }
      expect(await executeCli(["providers", "list", "--json"], {
        environment: {
          MYAGENT_API_URL: "http://127.0.0.1:8787",
          MYAGENT_ADMIN_TOKEN: "test-admin-token",
        },
        fetcher: injectFetcher(harness.app),
        write: (line) => cliOutput.push(line),
        writeError: (line) => cliErrors.push(line),
      })).toBe(0);

      const discovery = await harness.app.inject({
        method: "POST",
        url: `/v1/admin/provider-connection-revisions/${connectionRevisionId}/discover`,
        remoteAddress: "127.0.0.1",
        headers: { authorization: "Bearer test-admin-token" },
        payload: { expectedRevision: 0 },
      });
      responses.push(discovery.payload);
      expect(discovery.statusCode).toBe(200);
      const profile = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/model-profiles",
        remoteAddress: "127.0.0.1",
        headers: { authorization: "Bearer test-admin-token" },
        payload: {
          slug: "leak-profile",
          displayName: "Leak Profile",
          connectionRevisionId,
          modelId: "manual-leak-model",
          protocol: "responses",
          maxInputTokens: 32_768,
          contextWindowSource: "operator",
          manualEntryAcknowledged: true,
        },
      });
      responses.push(profile.payload);
      expect(profile.statusCode).toBe(201);
      const profileBody = profile.json() as {
        recordRevision: number;
        revisions: Array<{ revisionId: string }>;
      };
      const profileRevisionId = profileBody.revisions[0]!.revisionId;
      const verification = await harness.app.inject({
        method: "POST",
        url: `/v1/admin/model-profile-revisions/${profileRevisionId}/verifications`,
        remoteAddress: "127.0.0.1",
        headers: { authorization: "Bearer test-admin-token" },
        payload: {
          expectedRevision: profileBody.recordRevision,
          capabilityBaseline: "text_and_single_tool_call_v1",
        },
      });
      responses.push(verification.payload);
      expect(verification.statusCode).toBe(202);
      harness.modelRegistry.recordProviderHealth({
        connectionRevisionId: connectionRevisionId as never,
        profileRevisionId: profileRevisionId as never,
        outcome: "failure",
        code: "provider_unavailable",
        safeStatus: 503,
        traceId: "trace-model-secret-leak",
        observedAt: harness.clock.now(),
      });
      const run = await harness.app.inject({
        method: "POST",
        url: "/v1/runs",
        remoteAddress: "127.0.0.1",
        headers: {
          authorization: "Bearer test-token",
          "idempotency-key": "model-secret-leak-run",
        },
        payload: {
          agentId: "primary",
          sessionKey: "model-secret-leak",
          input: { type: "text", text: "populate durable leakage surfaces" },
        },
      });
      responses.push(run.payload);
      expect(run.statusCode).toBe(202);

      const backup = await harness.app.inject({
        method: "POST",
        url: "/v1/backups",
        remoteAddress: "127.0.0.1",
        headers: { authorization: "Bearer test-token" },
        payload: { destination: backupPath },
      });
      responses.push(backup.payload);
      expect(backup.statusCode).toBe(201);

      secretMetadata = harness.connection.db.prepare(
        `SELECT key_id, hex(ciphertext) AS ciphertext
         FROM managed_secret_versions`,
      ).all() as Array<{ key_id: string; ciphertext: string }>;
      prohibitedDurableSurfaces = JSON.stringify({
        connections: harness.connection.db.prepare(
          "SELECT auth_json FROM provider_connection_revisions",
        ).all(),
        events: harness.connection.db.prepare(
          "SELECT payload_json FROM model_registry_events",
        ).all(),
        verifications: harness.connection.db.prepare(
          "SELECT * FROM model_verifications",
        ).all(),
        health: harness.connection.db.prepare(
          "SELECT * FROM provider_health",
        ).all(),
        revisions: harness.connection.db.prepare(
          "SELECT content_json FROM agent_revisions",
        ).all(),
        runEvents: harness.connection.db.prepare(
          "SELECT payload_json FROM run_events",
        ).all(),
      });
    } finally {
      await harness.close();
    }

    const databaseFiles = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
      .filter(existsSync)
      .map((path) => readFileSync(path).toString("latin1"));
    const backupFiles = await Promise.all([
      readFile(path.join(backupPath, "kernel.db"), "latin1"),
      readFile(path.join(backupPath, "manifest.json"), "utf8"),
    ]);
    const publicSurfaces = [...responses, ...logs, ...cliOutput, ...cliErrors].join("\n");
    const captured = [
      publicSurfaces,
      prohibitedDurableSurfaces,
      ...databaseFiles,
      ...backupFiles,
    ].join("\n");
    expect(logs.every((line) => typeof JSON.parse(line) === "object")).toBe(true);
    expect(captured).not.toContain(plaintext);
    const stored = secretMetadata[0];
    expect(stored).toBeDefined();
    const prohibitedMetadataSurfaces = [
      publicSurfaces,
      prohibitedDurableSurfaces,
      backupFiles[1],
    ].join("\n");
    expect(prohibitedMetadataSurfaces.includes(stored!.key_id)).toBe(false);
    expect(prohibitedMetadataSurfaces.includes(stored!.ciphertext.slice(0, 16))).toBe(false);
    await rm(backupPath, { recursive: true, force: true });
  }, 30_000);

  it("destroys an unreferenced Secret only after separate confirmation", async () => {
    const plaintext = "needle-destroy-provider-key-14";
    const harness = await startTestApp();
    const responses: string[] = [];
    try {
      const created = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/provider-connections",
        remoteAddress: "127.0.0.1",
        headers: { authorization: "Bearer test-admin-token" },
        payload: {
          slug: "destroy-secret-provider",
          displayName: "Destroy Secret Provider",
          kind: "openai",
          auth: { type: "api_key" },
          apiKey: plaintext,
        },
      });
      responses.push(created.payload);
      const secretVersionId = created.json().secretVersionId as string;
      const connectionRevisionId = created.json().revisions[0].revisionId as string;

      const staleReferenced = await harness.app.inject({
        method: "POST",
        url: `/v1/admin/managed-secret-versions/${secretVersionId}/destruction`,
        remoteAddress: "127.0.0.1",
        headers: { authorization: "Bearer test-admin-token" },
        payload: { expectedRevision: 1, confirm: true },
      });
      responses.push(staleReferenced.payload);
      expect(staleReferenced.statusCode).toBe(409);
      expect(staleReferenced.json()).toMatchObject({ code: "revision_conflict" });
      expect(staleReferenced.payload).not.toContain("ownerCategories");

      const referenced = await harness.app.inject({
        method: "POST",
        url: `/v1/admin/managed-secret-versions/${secretVersionId}/destruction`,
        remoteAddress: "127.0.0.1",
        headers: { authorization: "Bearer test-admin-token" },
        payload: { expectedRevision: 0, confirm: true },
      });
      responses.push(referenced.payload);
      expect(referenced.statusCode).toBe(409);
      expect(referenced.json()).toMatchObject({
        code: "resource_in_use",
        ownerCategories: ["provider_connection_revision"],
      });
      expect(referenced.payload).not.toContain(secretVersionId);
      expect(referenced.payload).not.toContain(connectionRevisionId);
      expect(referenced.payload).not.toContain("destroy-secret-provider");

      const purged = await harness.app.inject({
        method: "POST",
        url: "/v1/admin/provider-connections/destroy-secret-provider/purge",
        remoteAddress: "127.0.0.1",
        headers: { authorization: "Bearer test-admin-token" },
        payload: { expectedRevision: 0, confirm: true },
      });
      expect(purged.statusCode).toBe(204);

      const unconfirmed = await harness.app.inject({
        method: "POST",
        url: `/v1/admin/managed-secret-versions/${secretVersionId}/destruction`,
        remoteAddress: "127.0.0.1",
        headers: { authorization: "Bearer test-admin-token" },
        payload: { expectedRevision: 0 },
      });
      responses.push(unconfirmed.payload);
      expect(unconfirmed.statusCode).toBe(400);

      const destroyed = await harness.app.inject({
        method: "POST",
        url: `/v1/admin/managed-secret-versions/${secretVersionId}/destruction`,
        remoteAddress: "127.0.0.1",
        headers: { authorization: "Bearer test-admin-token" },
        payload: { expectedRevision: 0, confirm: true },
      });
      responses.push(destroyed.payload);
      expect(destroyed.statusCode).toBe(204);
      expect(destroyed.payload).toBe("");

      const row = harness.connection.db.prepare(
        `SELECT state, record_revision, length(ciphertext) AS ciphertext_length,
                length(nonce) AS nonce_length,
                length(authentication_tag) AS authentication_tag_length
         FROM managed_secret_versions WHERE version_id = ?`,
      ).get(secretVersionId);
      expect(row).toEqual({
        state: "destroyed",
        record_revision: 1,
        ciphertext_length: 0,
        nonce_length: 0,
        authentication_tag_length: 0,
      });
      expect(responses.join("\n")).not.toContain(plaintext);
      expect(responses.join("\n")).not.toContain("ciphertext");
      expect(responses.join("\n")).not.toContain("keyId");
    } finally {
      await harness.close();
    }
  });

  it("rotates the singleton keyring without accepting or returning key material", async () => {
    const database = openDatabase({
      path: tempPath("http-master-key-rotation.db"),
      busyTimeoutMs: 5_000,
    });
    migrate(database.db);
    const previousKey = Buffer.alloc(32, 0x21).toString("base64");
    const currentKey = Buffer.alloc(32, 0x42).toString("base64");
    const versionId = managedSecretVersionIdFromUuid("http-rotation");
    const now = new Date("2026-08-07T00:00:00.000Z");
    new SqliteEncryptedSecretStore(database.db, {
      MYAGENT_MASTER_KEY: previousKey,
    }).createVersion({
      versionId,
      secretId: "rotation-provider-key",
      purpose: "provider_api_key",
      plaintext: "needle-rotation-plaintext-14",
      now,
    });
    const secrets = new ManageSecretsService(
      new SqliteEncryptedSecretStore(database.db, {
        MYAGENT_MASTER_KEY: currentKey,
        MYAGENT_PREVIOUS_MASTER_KEY: previousKey,
      }),
      { inspectSecretReferences: () => [] },
      new FakeClock(now),
      { managedSecretVersionId: () => versionId },
      { run: (operation) => withImmediateTransaction(database.db, operation) },
    );
    const app = createHttpApp({
      bearerToken: "test-token",
      adminToken: "test-admin-token",
      modelControl: {
        registry: {} as ModelControlServices["registry"],
        connections: {} as ModelControlServices["connections"],
        profiles: {} as ModelControlServices["profiles"],
        secrets,
        assignments: {} as ModelControlServices["assignments"],
        discovery: {} as ModelControlServices["discovery"],
        verifications: {} as ModelControlServices["verifications"],
      },
    });
    try {
      const rejected = await app.inject({
        method: "POST",
        url: "/v1/admin/managed-secrets/master-key-rotation",
        remoteAddress: "127.0.0.1",
        headers: { authorization: "Bearer test-admin-token" },
        payload: { expectedRevision: 0, masterKey: "must-never-be-accepted" },
      });
      expect(rejected.statusCode).toBe(400);
      expect(database.db.prepare(
        "SELECT record_revision FROM managed_secret_keyring WHERE singleton_id = 1",
      ).get()).toEqual({ record_revision: 0 });

      const rotated = await app.inject({
        method: "POST",
        url: "/v1/admin/managed-secrets/master-key-rotation",
        remoteAddress: "127.0.0.1",
        headers: { authorization: "Bearer test-admin-token" },
        payload: { expectedRevision: 0 },
      });
      expect(rotated.statusCode).toBe(200);
      expect(rotated.json()).toEqual({
        reencrypted: 1,
        currentKeyId: expect.any(String),
        recordRevision: 1,
      });
      expect(Object.keys(rotated.json()).sort()).toEqual([
        "currentKeyId",
        "recordRevision",
        "reencrypted",
      ]);
      expect(`${rejected.payload}${rotated.payload}`).not.toContain(currentKey);
      expect(`${rejected.payload}${rotated.payload}`).not.toContain(previousKey);
      expect(`${rejected.payload}${rotated.payload}`).not.toContain("needle-rotation-plaintext-14");
    } finally {
      await app.close();
      database.close();
    }
  });
});

function injectFetcher(app: FastifyInstance): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const injected = await app.inject({
      method: (init?.method ?? "GET") as never,
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(typeof init?.body === "string" ? { payload: init.body } : {}),
    });
    return new Response(injected.statusCode === 204 ? null : injected.payload, {
      status: injected.statusCode,
      headers: injected.headers as Record<string, string>,
    });
  }) as typeof fetch;
}
