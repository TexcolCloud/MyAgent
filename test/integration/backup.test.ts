import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { openDatabase } from "../../src/adapters/sqlite/database.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
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
        activeRevisionIds: harness.catalog.current().available.map((agent) => agent.revision.revisionId).sort(),
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
});
