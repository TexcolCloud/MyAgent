import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadBootConfig } from "../../src/config/boot-config.js";
import {
  initializeProjectState,
  inspectProjectState,
  resolveLocalProjectPaths,
} from "../../src/interfaces/local/project-state.js";

const localMinimalFixture = path.resolve(
  "test",
  "fixtures",
  "config",
  "local-minimal",
  "myagent.yaml",
);

const databaseArtifacts = [
  ["database", ""],
  ["write-ahead log", "-wal"],
  ["shared-memory file", "-shm"],
] as const;

describe("local project state", () => {
  it("resolves the default state below .myagent and reports it absent", async () => {
    const paths = resolveLocalProjectPaths("C:\\repo");

    expect(paths.configPath).toBe(path.resolve("C:\\repo", ".myagent", "myagent.yaml"));
    expect(paths.root).toBe(path.resolve("C:\\repo", ".myagent"));
    expect(paths.databasePath).toBe(path.resolve("C:\\repo", ".myagent", "state.sqlite"));
    expect(await inspectProjectState(paths)).toBe("absent");
  });

  it("initializes the minimum model-free state in a real workspace", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "myagent-project-state-"));
    const paths = resolveLocalProjectPaths(workspace);
    try {
      await initializeProjectState(paths);

      expect(await inspectProjectState(paths)).toBe("ready");
      expect(await loadBootConfig(paths.configPath)).toMatchObject({
        version: 2,
        server: {
          host: "127.0.0.1",
          port: 8787,
          bearerToken: { fromEnvironment: "MYAGENT_BEARER_TOKEN" },
          adminToken: { fromEnvironment: "MYAGENT_ADMIN_TOKEN" },
        },
        database: { path: "state.sqlite" },
        agentRoots: ["agents"],
        skillRoots: ["skills"],
      });
      expect(await readdir(paths.agentsRoot)).toEqual([]);
      expect(await readdir(paths.skillsRoot)).toEqual([]);
      expect((await readdir(paths.root)).sort()).toEqual([
        "agents",
        "myagent.yaml",
        "skills",
      ]);
      expect((await readdir(paths.root)).find((entry) => entry.includes(".tmp-")))
        .toBeUndefined();
      expect((await readdir(paths.root)).find((entry) => entry.endsWith(".owner")))
        .toBeUndefined();
      expect(await readFile(paths.configPath, "utf8"))
        .toBe(await readFile(localMinimalFixture, "utf8"));
      expect(await readFile(paths.configPath, "utf8"))
        .not.toMatch(/(?:^|\n)(?:models|model|provider|default):/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses an explicit config path without selecting a workspace-root myagent.yaml", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "myagent-project-state-"));
    const explicit = path.join(workspace, "settings", "myagent.yaml");
    try {
      await writeFile(path.join(workspace, "myagent.yaml"), "version: 3\n");
      const paths = resolveLocalProjectPaths(workspace, explicit);

      expect(paths.configPath).toBe(explicit);
      expect(paths.root).toBe(path.join(workspace, ".myagent"));
      expect(await inspectProjectState(paths)).toBe("absent");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("refuses partial or existing state without mutating it", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "myagent-project-state-"));
    const paths = resolveLocalProjectPaths(workspace);
    try {
      await mkdir(paths.root, { recursive: true });
      await writeFile(paths.configPath, "version: 2\n");

      expect(await inspectProjectState(paths)).toBe("partial");
      await expect(initializeProjectState(paths)).rejects.toThrow("partial");
      expect(await inspectProjectState(paths)).toBe("partial");

      await rm(paths.root, { recursive: true });
      await initializeProjectState(paths);
      await expect(initializeProjectState(paths)).rejects.toThrow("ready");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each(databaseArtifacts)(
    "classifies an orphan SQLite %s as partial state",
    async (_description, suffix) => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), "myagent-project-state-"));
      const paths = resolveLocalProjectPaths(workspace);
      try {
        await mkdir(paths.root, { recursive: true });
        await writeFile(`${paths.databasePath}${suffix}`, "historical database bytes");

        expect(await inspectProjectState(paths)).toBe("partial");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  it.each(databaseArtifacts)(
    "refuses initialization over an orphan SQLite %s and preserves its bytes",
    async (_description, suffix) => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), "myagent-project-state-"));
      const paths = resolveLocalProjectPaths(workspace);
      const artifactPath = `${paths.databasePath}${suffix}`;
      const historicalBytes = `historical ${suffix || "database"} bytes\n`;
      try {
        await mkdir(paths.root, { recursive: true });
        await writeFile(artifactPath, historicalBytes);

        await expect(initializeProjectState(paths)).rejects.toThrow("partial");
        expect(await readFile(artifactPath, "utf8")).toBe(historicalBytes);
        expect(await readdir(paths.root)).toEqual([path.basename(artifactPath)]);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  it("treats a configuration directory as partial state", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "myagent-project-state-"));
    const paths = resolveLocalProjectPaths(workspace);
    try {
      await mkdir(paths.configPath, { recursive: true });
      await mkdir(paths.agentsRoot);
      await mkdir(paths.skillsRoot);

      expect(await inspectProjectState(paths)).toBe("partial");
      await expect(initializeProjectState(paths)).rejects.toThrow("partial");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves a competing exclusive temporary file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "myagent-project-state-"));
    const paths = resolveLocalProjectPaths(workspace);
    const competingTemporaryPath = path.join(paths.root, "competing-temporary.yaml");
    try {
      await mkdir(paths.root, { recursive: true });
      await writeFile(competingTemporaryPath, "competitor bytes");

      await expect(initializeProjectState(paths, {
        temporaryPath: () => competingTemporaryPath,
      })).rejects.toThrow();

      expect(await readFile(competingTemporaryPath, "utf8")).toBe("competitor bytes");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not replace configuration created after inspection", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "myagent-project-state-"));
    const paths = resolveLocalProjectPaths(workspace);
    const competingConfig = "competitor configuration\n";
    try {
      await expect(initializeProjectState(paths, {
        beforeCommit: async () => {
          await writeFile(paths.configPath, competingConfig);
        },
      })).rejects.toThrow();

      expect(await readFile(paths.configPath, "utf8")).toBe(competingConfig);
      expect((await readdir(paths.root)).sort()).toEqual([
        "agents",
        "myagent.yaml",
        "skills",
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves a detectable replacement temporary file before cleanup", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "myagent-project-state-"));
    const paths = resolveLocalProjectPaths(workspace);
    const temporaryPath = path.join(paths.root, "owned-temporary.yaml");
    const replacement = "competitor replacement\n";
    try {
      await initializeProjectState(paths, {
        temporaryPath: () => temporaryPath,
        beforeCleanup: async () => {
          await rm(temporaryPath);
          await writeFile(temporaryPath, replacement);
        },
      });

      expect((await loadBootConfig(paths.configPath)).version).toBe(2);
      expect(await readFile(temporaryPath, "utf8")).toBe(replacement);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("removes its temporary file when ownership-marker creation fails", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "myagent-project-state-"));
    const paths = resolveLocalProjectPaths(workspace);
    const temporaryPath = path.join(paths.root, "owned-temporary.yaml");
    try {
      await expect(initializeProjectState(paths, {
        temporaryPath: () => temporaryPath,
        createOwnershipMarker: async () => {
          throw new Error("marker creation failed");
        },
      })).rejects.toThrow("marker creation failed");

      expect(await readdir(paths.root)).toEqual(["agents", "skills"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
