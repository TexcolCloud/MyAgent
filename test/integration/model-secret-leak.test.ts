import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { openDatabase } from "../../src/adapters/sqlite/database.js";
import { SqliteEncryptedSecretStore } from "../../src/adapters/sqlite/encrypted-secret-store.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { ManageSecretsService } from "../../src/application/manage-secrets.js";
import { managedSecretVersionIdFromUuid } from "../../src/domain/ids.js";
import {
  createHttpApp,
  type ModelControlServices,
} from "../../src/interfaces/http/app.js";
import { createStructuredLogger } from "../../src/observability/logger.js";
import { FakeClock } from "../helpers/fake-clock.js";
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
