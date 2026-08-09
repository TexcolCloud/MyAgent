import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { EnvironmentSecretResolver } from "../../src/adapters/environment-secret-resolver.js";
import { loadCatalog } from "../../src/config/catalog-loader.js";
import { CatalogService } from "../../src/config/catalog-service.js";
import { parseAgentId } from "../../src/domain/ids.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/config", import.meta.url));

describe("CatalogService", () => {
  it("publishes one current snapshot and resolves only available Agents", async () => {
    const snapshot = await loadCatalog(path.join(FIXTURE_ROOT, "valid", "myagent.yaml"));
    const service = new CatalogService(snapshot);

    expect(service.current()).toBe(snapshot);
    expect(service.resolve(parseAgentId("primary")).id).toBe("primary");
    expect(() => service.resolve(parseAgentId("missing"))).toThrowError(
      expect.objectContaining({ code: "agent_unavailable" }),
    );
  });

  it("atomically reloads Agent changes but rejects restart-only global changes", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "myagent-reload-"));
    const configRoot = path.join(temporary, "config");
    await cp(path.join(FIXTURE_ROOT, "valid"), configRoot, { recursive: true });

    try {
      const configPath = path.join(configRoot, "myagent.yaml");
      const service = new CatalogService(await loadCatalog(configPath));
      const originalRevision = service.resolve(parseAgentId("primary"))
        .definition.definitionRevisionId;

      await writeFile(
        path.join(configRoot, "agents", "primary", "AGENT.md"),
        "Updated primary instructions.\n",
      );
      const reloaded = await service.reload();
      expect(reloaded.byId.get(parseAgentId("primary"))?.definition.definitionRevisionId).not.toBe(
        originalRevision,
      );

      const active = service.current();
      const yaml = await readFile(configPath, "utf8");
      await writeFile(configPath, yaml.replace("server:\n", "server:\n  port: 9999\n"));
      await expect(service.reload()).rejects.toMatchObject({ code: "restart_required" });
      expect(service.current()).toBe(active);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it.each([
    {
      change: "addition",
      update: (yaml: string) => yaml.replace("  - PATH\n", "  - PATH\n  - HOME\n"),
    },
    {
      change: "revocation",
      update: (yaml: string) => yaml.replace(
        "toolEnvironmentAllowlist:\n  - PATH\n",
        "toolEnvironmentAllowlist: []\n",
      ),
    },
  ])(
    "rejects an environment allowlist $change without replacing the active snapshot",
    async ({ update }) => {
      const temporary = await mkdtemp(path.join(os.tmpdir(), "myagent-reload-env-"));
      const configRoot = path.join(temporary, "config");
      await cp(path.join(FIXTURE_ROOT, "valid"), configRoot, { recursive: true });

      try {
        const configPath = path.join(configRoot, "myagent.yaml");
        const service = new CatalogService(await loadCatalog(configPath));
        const active = service.current();
        await writeFile(
          configPath,
          update(await readFile(configPath, "utf8")),
        );

        await expect(service.reload()).rejects.toMatchObject({
          code: "restart_required",
        });
        expect(service.current()).toBe(active);
        expect(service.current().global.toolEnvironmentAllowlist).toEqual([
          "PATH",
        ]);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
  );

  it("resolves only named environment references and redacts unavailable secrets", () => {
    const resolver = new EnvironmentSecretResolver({ PRESENT_SECRET: "sensitive-value" });

    expect(resolver.resolve({ fromEnvironment: "PRESENT_SECRET" })).toBe(
      "sensitive-value",
    );
    expect(() => resolver.resolve({ fromEnvironment: "MISSING_SECRET" })).toThrowError(
      expect.objectContaining({
        code: "secret_locked",
        message: expect.not.stringContaining("sensitive-value"),
      }),
    );
  });
});
