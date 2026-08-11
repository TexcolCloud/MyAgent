import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";

import { loadBootConfig } from "../../src/config/boot-config.js";

const legacyFixture = fileURLToPath(
  new URL("../fixtures/config/legacy-v1/myagent.yaml", import.meta.url),
);
const version2Fixture = fileURLToPath(
  new URL("../fixtures/config/version-2/myagent.yaml", import.meta.url),
);

describe("loadBootConfig", () => {
  it("keeps legacy aliases only as import seeds", async () => {
    const boot = await loadBootConfig(legacyFixture);

    expect(boot.legacyModelImport?.models.default?.modelId).toBe("test-model");
    expect(boot.legacyModelImport?.agentAliases).toEqual({ primary: "default" });
    expect(boot.version).toBe(1);
  });

  it("loads immutable version 2 static configuration without an import seed", async () => {
    const boot = await loadBootConfig(version2Fixture);

    expect(boot.version).toBe(2);
    if (boot.version !== 2) throw new Error("expected version 2 configuration");
    expect(boot.legacyModelImport).toBeUndefined();
    expect(Object.isFrozen(boot)).toBe(true);
    expect(Object.isFrozen(boot.modelControl)).toBe(true);
  });

  it("rejects a legacy Agent that names an unknown model alias", async () => {
    const fixture = await copyLegacyFixture("unknown-alias");
    try {
      const agentPath = path.join(fixture.root, "agents", "primary", "agent.yaml");
      await writeFile(
        agentPath,
        (await readFile(agentPath, "utf8")).replace(
          "model: default",
          "model: missing",
        ),
      );

      await expect(loadBootConfig(fixture.configPath)).rejects.toThrow(
        "unknown legacy model alias: missing",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects duplicate legacy Agent IDs before building import assignments", async () => {
    const fixture = await copyLegacyFixture("duplicate-agent");
    try {
      await cp(
        path.join(fixture.root, "agents", "primary"),
        path.join(fixture.root, "agents", "duplicate"),
        { recursive: true },
      );

      await expect(loadBootConfig(fixture.configPath)).rejects.toThrow(
        "duplicate legacy Agent ID: primary",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a legacy agent.yaml junction that escapes its Agent directory", async () => {
    const fixture = await copyLegacyFixture("confined-agent");
    const agentPath = path.join(fixture.root, "agents", "primary", "agent.yaml");
    const outside = path.join(fixture.root, "outside-agent-source");
    try {
      await rm(agentPath);
      await cp(path.join(fixture.root, "agents", "primary"), outside, {
        recursive: true,
      });
      await symlink(outside, agentPath, "junction");

      await expect(loadBootConfig(fixture.configPath)).rejects.toThrow(
        "legacy Agent path escapes Agent directory",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("derives the same legacy source hash after YAML fields are reordered", async () => {
    const first = await copyLegacyFixture("hash-first");
    const second = await copyLegacyFixture("hash-second");
    try {
      const parsed = parseYaml(await readFile(second.configPath, "utf8")) as {
        server: unknown;
        database: unknown;
        agentRoots: unknown;
        models: { default: Record<string, unknown> };
      };
      const model = parsed.models.default;
      await writeFile(second.configPath, stringifyYaml({
        models: {
          default: {
            maxInputTokens: model.maxInputTokens,
            apiKey: model.apiKey,
            baseUrl: model.baseUrl,
            model: model.model,
            provider: model.provider,
          },
        },
        agentRoots: parsed.agentRoots,
        database: parsed.database,
        server: parsed.server,
      }));

      expect((await loadBootConfig(second.configPath)).legacyModelImport?.sourceSha256)
        .toBe((await loadBootConfig(first.configPath)).legacyModelImport?.sourceSha256);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  it("rejects unsupported static configuration versions", async () => {
    const fixture = await copyLegacyFixture("unsupported-version");
    try {
      await writeFile(
        fixture.configPath,
        `version: 3\n${await readFile(fixture.configPath, "utf8")}`,
      );

      await expect(loadBootConfig(fixture.configPath)).rejects.toThrow();
    } finally {
      await fixture.cleanup();
    }
  });
});

async function copyLegacyFixture(name: string): Promise<{
  root: string;
  configPath: string;
  cleanup(): Promise<void>;
}> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), `myagent-legacy-${name}-`));
  const root = path.join(temporary, "config");
  await cp(path.dirname(legacyFixture), root, { recursive: true });
  return {
    root,
    configPath: path.join(root, "myagent.yaml"),
    async cleanup(): Promise<void> {
      await rm(temporary, { recursive: true, force: true });
    },
  };
}
