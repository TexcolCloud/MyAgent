import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { runLocalCliFixture } from "../helpers/local-cli-fixture.js";

describe("Local Integrated Mode", () => {
  it("owns one ephemeral loopback host until CLI exit and reopens durable state on restart", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "myagent-local-e2e-"));
    const databasePath = path.join(workspace, ".myagent", "state.sqlite");

    try {
      const first = await runLocalCliFixture({ workspace });
      expect(first.exitCode).toBe(0);
      expect(first.consentPrompts).toHaveLength(1);
      expect(first.listen).toEqual([{ host: "127.0.0.1", port: 0 }]);
      expect(first.urls).toHaveLength(1);
      expect(new URL(first.urls[0]!).hostname).toBe("127.0.0.1");
      expect(Number(new URL(first.urls[0]!).port)).toBeGreaterThan(0);
      await expect(fetch(`${first.urls[0]!}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      })).rejects.toThrow();

      const reopened = new DatabaseSync(databasePath);
      try {
        expect(reopened.prepare(
          "SELECT COUNT(*) AS count FROM schema_migrations",
        ).get()).toEqual({ count: 3 });
      } finally {
        reopened.close();
      }

      const restarted = await runLocalCliFixture({ workspace });
      expect(restarted.exitCode).toBe(0);
      expect(restarted.consentPrompts).toEqual([]);
      expect(restarted.listen).toEqual([{ host: "127.0.0.1", port: 0 }]);
      await expect(fetch(`${restarted.urls[0]!}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      })).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 20_000);
});
