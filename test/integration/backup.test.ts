import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { openDatabase } from "../../src/adapters/sqlite/database.js";
import { SqliteBackupWriter } from "../../src/adapters/sqlite/backup.js";
import { SqliteEncryptedSecretStore } from "../../src/adapters/sqlite/encrypted-secret-store.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { loadCatalog } from "../../src/config/catalog-loader.js";
import type { CatalogSnapshot } from "../../src/config/catalog-loader.js";
import { managedSecretVersionIdFromUuid } from "../../src/domain/ids.js";
import { tempPath } from "../helpers/temp-dir.js";
import { startTestApp } from "../helpers/start-test-app.js";

interface BackupManifest {
  schemaVersion: number;
  database: string;
  files: string[];
  sha256: Record<string, string>;
  activeRevisionIds: string[];
}

describe("HTTP backup", () => {
  it("publishes an online SQLite backup with exactly the active catalog sources", async () => {
    const harness = await startTestApp();
    const destination = tempPath("http-backup");
    try {
      await harness.app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { authorization: "Bearer test-token", "idempotency-key": "backup-run-0001" },
        payload: { agentId: "primary", sessionKey: "backup:session", input: { type: "text", text: "persist me" } },
      });

      const response = await harness.app.inject({
        method: "POST",
        url: "/v1/backups",
        headers: { authorization: "Bearer test-token" },
        payload: { destination },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ destination: path.resolve(destination), database: "kernel.db" });

      const manifest = JSON.parse(await readFile(path.join(destination, "manifest.json"), "utf8")) as BackupManifest;
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        database: "kernel.db",
        files: expect.arrayContaining([
          "kernel.db",
          "myagent.yaml",
          "agents/primary/AGENT.md",
          "agents/primary/agent.yaml",
          "agents/primary/policy.yaml",
          "skills/research/SKILL.md",
        ]),
        activeRevisionIds: harness.catalog.current().available
          .map((agent) => agent.definition.definitionRevisionId)
          .sort(),
      });
      expect(Object.keys(manifest.sha256).sort()).toEqual([...manifest.files].sort());
      for (const digest of Object.values(manifest.sha256)) expect(digest).toMatch(/^[a-f0-9]{64}$/);

      const backup = openDatabase({ path: path.join(destination, "kernel.db"), busyTimeoutMs: 5_000 });
      try {
        expect(() => migrate(backup.db)).not.toThrow();
        expect(backup.db.prepare("SELECT COUNT(*) AS count FROM runs").get()).toEqual({ count: 1 });
      } finally {
        backup.close();
      }

      const conflict = await harness.app.inject({
        method: "POST",
        url: "/v1/backups",
        headers: { authorization: "Bearer test-token" },
        payload: { destination },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ code: "backup_destination_exists" });
      expect((await readdir(path.dirname(destination))).filter((entry) => entry.includes(".partial-"))).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("rejects unknown backup request properties", async () => {
    const harness = await startTestApp();
    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/v1/backups",
        headers: { authorization: "Bearer test-token" },
        payload: { destination: tempPath("invalid-backup"), extra: true },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request" });
    } finally {
      await harness.close();
    }
  });

  it("restores encrypted Secret rows with the external key while excluding Secret data from the manifest", async () => {
    const databasePath = tempPath("backup-managed-secret.db");
    const destination = tempPath("backup-managed-secret");
    const masterKey = Buffer.alloc(32, 29).toString("base64");
    const plaintext = "backup-provider-plaintext";
    const versionId = managedSecretVersionIdFromUuid("backup-managed-secret");
    const connection = openDatabase({ path: databasePath, busyTimeoutMs: 5_000 });
    try {
      migrate(connection.db);
      const metadata = new SqliteEncryptedSecretStore(connection.db, {
        MYAGENT_MASTER_KEY: masterKey,
      }).createVersion({
        versionId,
        secretId: "backup-provider-key",
        purpose: "provider_api_key",
        plaintext,
        now: new Date("2026-08-09T00:00:00.000Z"),
      });
      await new SqliteBackupWriter(connection.db).create({
        destination,
        catalog: await loadCatalog("test/fixtures/config/valid/myagent.yaml"),
        occurredAt: new Date("2026-08-09T00:01:00.000Z"),
      });

      const manifest = await readFile(path.join(destination, "manifest.json"), "utf8");
      expect(manifest).not.toContain(masterKey);
      expect(manifest).not.toContain(plaintext);
      expect(manifest).not.toContain(versionId);
      expect(manifest).not.toContain(metadata.secretId);
      expect(manifest).not.toContain(metadata.keyId);
      expect((await readFile(path.join(destination, "kernel.db"))).includes(
        Buffer.from(plaintext),
      )).toBe(false);

      const restored = openDatabase({
        path: path.join(destination, "kernel.db"),
        busyTimeoutMs: 5_000,
      });
      try {
        expect(new SqliteEncryptedSecretStore(restored.db, {
          MYAGENT_MASTER_KEY: masterKey,
        }).resolve(versionId)).toBe(plaintext);
      } finally {
        restored.close();
      }
    } finally {
      connection.close();
      await rm(databasePath, { force: true });
      await rm(destination, { recursive: true, force: true });
    }
  });

  it("rejects source paths that become traversal paths on another platform", async () => {
    const databasePath = tempPath("backup-source-guard.db");
    const destination = tempPath("backup-source-guard");
    const escaped = path.join(path.dirname(destination), "escaped", "SKILL.md");
    const connection = openDatabase({ path: databasePath, busyTimeoutMs: 5_000 });
    migrate(connection.db);
    const writer = new SqliteBackupWriter(connection.db);
    const catalog = {
      available: [],
      sources: [{
        relativePath: "skills/..\\..\\escaped/SKILL.md",
        content: "must remain inside the backup",
      }],
    } as unknown as CatalogSnapshot;

    try {
      await expect(writer.create({
        destination,
        catalog,
        occurredAt: new Date("2026-08-07T00:00:00.000Z"),
      })).rejects.toMatchObject({ code: "invalid_backup_source_path" });
      await expect(readFile(escaped, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      connection.close();
      await rm(destination, { recursive: true, force: true });
      await rm(path.dirname(escaped), { recursive: true, force: true });
    }
  });
});
