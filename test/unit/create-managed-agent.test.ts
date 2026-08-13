import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { describe, expect, it, vi } from "vitest";

import { CreateManagedAgentService } from "../../src/application/create-managed-agent.js";
import { loadCatalog } from "../../src/config/catalog-loader.js";
import { CatalogService } from "../../src/config/catalog-service.js";

describe("CreateManagedAgentService", () => {
  it("creates a validated Agent atomically in the canonical project-managed root", async () => {
    const project = await localProject();
    try {
      const catalog = new CatalogService(await loadCatalog(project.configPath));
      const service = new CreateManagedAgentService(catalog);

      const created = await service.execute(input(catalog.revision()));

      expect(created.agent.id).toBe("writer");
      expect(created.catalogRevision).toBe(catalog.revision());
      expect(await realpath(path.join(project.agentsRoot, "writer"))).toBe(
        await realpath(path.join(project.agentsRoot, "writer")),
      );
      expect(parseYaml(await readFile(path.join(project.agentsRoot, "writer", "agent.yaml"), "utf8"))).toMatchObject({
        id: "writer", prompt: "./AGENT.md", policy: "./policy.yaml", skills: [], delegates: [],
      });
      expect(await readFile(path.join(project.agentsRoot, "writer", "AGENT.md"), "utf8")).toBe("Write clearly.\n");
      expect(catalog.current().byId.get("writer" as never)?.definition.policy).toEqual([]);
      expect((await readdir(project.agentsRoot)).filter((name) => name.includes("tmp"))).toEqual([]);
    } finally { await project.close(); }
  });

  it("keeps staging outside the loader-scanned Agent root", async () => {
    const project = await localProject();
    try {
      const catalog = new CatalogService(await loadCatalog(project.configPath));
      const validate = catalog.validate.bind(catalog);
      const scannedDirectories: string[][] = [];
      vi.spyOn(catalog, "validate").mockImplementation(async () => {
        scannedDirectories.push(await readdir(project.agentsRoot));
        return validate();
      });

      await new CreateManagedAgentService(catalog).execute(input(catalog.revision()));

      expect(scannedDirectories.at(-1)).toEqual(["writer"]);
      expect(scannedDirectories.every((entries) =>
        entries.every((entry) => !entry.includes("tmp")),
      )).toBe(true);
    } finally { await project.close(); }
  });

  it.each(["../escape", "writer/escape", "..\\escape"])("rejects path escape Agent ID %s", async (id) => {
    const project = await localProject();
    try {
      const catalog = new CatalogService(await loadCatalog(project.configPath));
      await expect(new CreateManagedAgentService(catalog).execute({ ...input(catalog.revision()), id }))
        .rejects.toMatchObject({ code: "invalid_managed_agent" });
      expect(await readdir(project.agentsRoot)).toEqual([]);
    } finally { await project.close(); }
  });

  it("rejects duplicate IDs without changing the existing Agent", async () => {
    const project = await localProject();
    try {
      const catalog = new CatalogService(await loadCatalog(project.configPath));
      const service = new CreateManagedAgentService(catalog);
      await service.execute(input(catalog.revision()));
      const original = await readFile(path.join(project.agentsRoot, "writer", "AGENT.md"), "utf8");

      await expect(service.execute({ ...input(catalog.revision()), prompt: "Replacement\n" }))
        .rejects.toMatchObject({ code: "managed_agent_exists" });
      expect(await readFile(path.join(project.agentsRoot, "writer", "AGENT.md"), "utf8")).toBe(original);
    } finally { await project.close(); }
  });

  it("rejects catalogs containing an unmanaged Agent root", async () => {
    const project = await localProject({ agentRoots: ["agents", "../other-agents"] });
    try {
      await mkdir(path.join(project.root, "..", "other-agents"));
      const catalog = new CatalogService(await loadCatalog(project.configPath));
      await expect(new CreateManagedAgentService(catalog).execute(input(catalog.revision())))
        .rejects.toMatchObject({ code: "unmanaged_agent_root" });
      expect(await readdir(project.agentsRoot)).toEqual([]);
    } finally { await project.close(); }
  });

  it("rejects invalid policies before creating the final directory", async () => {
    const project = await localProject();
    try {
      const catalog = new CatalogService(await loadCatalog(project.configPath));
      await expect(new CreateManagedAgentService(catalog).execute({
        ...input(catalog.revision()),
        policy: { rules: [{ tool: "read_file", effect: "allow", when: { pathWithinWorkspace: false } as never }] },
      })).rejects.toMatchObject({ code: "invalid_managed_agent" });
      expect(await readdir(project.agentsRoot)).toEqual([]);
    } finally { await project.close(); }
  });

  it("rejects structurally valid allow rules and grants no Tool authority", async () => {
    const project = await localProject();
    try {
      const catalog = new CatalogService(await loadCatalog(project.configPath));
      await expect(new CreateManagedAgentService(catalog).execute({
        ...input(catalog.revision()),
        policy: { rules: [{ tool: "read_file", effect: "allow" }] },
      })).rejects.toMatchObject({ code: "invalid_managed_agent" });
      expect(await readdir(project.agentsRoot)).toEqual([]);
      expect(catalog.current().available).toEqual([]);
    } finally { await project.close(); }
  });

  it("removes only its known staging directory after a write failure", async () => {
    const project = await localProject();
    try {
      const unrelated = path.join(project.agentsRoot, ".unrelated-tmp");
      await mkdir(unrelated);
      const catalog = new CatalogService(await loadCatalog(project.configPath));
      let writes = 0;
      const service = new CreateManagedAgentService(catalog, {
        writeFile: async (file, content) => {
          writes += 1;
          if (writes === 2) throw new Error("forced_write_failure");
          await writeFile(file, content, { flag: "wx" });
        },
      });

      await expect(service.execute(input(catalog.revision()))).rejects.toThrow("forced_write_failure");
      expect(await readdir(project.agentsRoot)).toEqual([".unrelated-tmp"]);
      await expect(lstat(path.join(project.agentsRoot, "writer"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await project.close(); }
  });

  it("rejects a stale catalog revision before staging and never retries", async () => {
    const project = await localProject();
    try {
      const catalog = new CatalogService(await loadCatalog(project.configPath));
      const write = vi.fn(async (file: string, content: string) => writeFile(file, content, { flag: "wx" }));
      const service = new CreateManagedAgentService(catalog, { writeFile: write });

      await expect(service.execute(input("catalog_stale"))).rejects.toMatchObject({ code: "revision_conflict" });
      expect(write).not.toHaveBeenCalled();
      expect(await readdir(project.agentsRoot)).toEqual([]);
    } finally { await project.close(); }
  });

  it("removes its published Agent when reload preparation fails", async () => {
    const project = await localProject();
    try {
      const catalog = new CatalogService(await loadCatalog(project.configPath));
      const service = new CreateManagedAgentService(catalog, {
        afterReload: () => { throw new Error("forced_reload_failure"); },
      });
      await expect(service.execute(input(catalog.revision()))).rejects.toThrow("forced_reload_failure");
      expect(await readdir(project.agentsRoot)).toEqual([]);
      expect(catalog.current().available).toEqual([]);
    } finally { await project.close(); }
  });

  it("serializes concurrent distinct creates and leaves catalog and files consistent", async () => {
    const project = await localProject();
    try {
      const catalog = new CatalogService(await loadCatalog(project.configPath));
      const service = new CreateManagedAgentService(catalog);
      const revision = catalog.revision();
      const results = await Promise.allSettled([
        service.execute({ ...input(revision), id: "alpha", displayName: "Alpha" }),
        service.execute({ ...input(revision), id: "beta", displayName: "Beta" }),
      ]);
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(results.filter(({ status }) => status === "rejected").map((result) =>
        result.status === "rejected" ? (result.reason as { code?: string }).code : undefined,
      )).toEqual(["revision_conflict"]);
      const directories = await readdir(project.agentsRoot);
      expect(directories).toHaveLength(1);
      expect(catalog.current().available.map(({ id }) => id)).toEqual(directories);
    } finally { await project.close(); }
  });

  it("serializes concurrent creates across independently loaded catalogs for one root", async () => {
    const project = await localProject();
    try {
      const firstCatalog = new CatalogService(await loadCatalog(project.configPath));
      const secondCatalog = new CatalogService(await loadCatalog(project.configPath));
      const revision = firstCatalog.revision();
      const results = await Promise.allSettled([
        new CreateManagedAgentService(firstCatalog).execute({
          ...input(revision), id: "alpha", displayName: "Alpha",
        }),
        new CreateManagedAgentService(secondCatalog).execute({
          ...input(revision), id: "beta", displayName: "Beta",
        }),
      ]);

      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(results.filter(({ status }) => status === "rejected").map((result) =>
        result.status === "rejected" ? (result.reason as { code?: string }).code : undefined,
      )).toEqual(["revision_conflict"]);
      const directories = await readdir(project.agentsRoot);
      expect(directories).toHaveLength(1);
      expect(firstCatalog.current().available.map(({ id }) => id)).toEqual(directories);
      expect(secondCatalog.current().available.map(({ id }) => id)).toEqual(directories);
    } finally { await project.close(); }
  });

  it("does not remove a target replaced by another actor during rollback", async () => {
    const project = await localProject();
    try {
      const target = path.join(project.agentsRoot, "writer");
      const catalog = new CatalogService(await loadCatalog(project.configPath));
      const service = new CreateManagedAgentService(catalog, {
        afterReload: () => {
          rmSync(target, { recursive: true });
          mkdirSync(target);
          writeFileSync(path.join(target, "owner.txt"), "external\n");
          throw new Error("forced_reload_failure");
        },
      });

      await expect(service.execute(input(catalog.revision()))).rejects.toThrow("forced_reload_failure");

      expect(await readFile(path.join(target, "owner.txt"), "utf8")).toBe("external\n");
      expect(catalog.current().available).toEqual([]);
    } finally { await project.close(); }
  });

  it("restores the catalog when response construction fails after reload commit", async () => {
    const project = await localProject();
    try {
      const catalog = new CatalogService(await loadCatalog(project.configPath));
      const revision = catalog.revision();
      const actualRevision = catalog.revision.bind(catalog);
      vi.spyOn(catalog, "revision").mockImplementation(() => {
        if (catalog.current().byId.has("writer" as never)) throw new Error("forced_response_failure");
        return actualRevision();
      });

      await expect(new CreateManagedAgentService(catalog).execute(input(revision)))
        .rejects.toThrow("forced_response_failure");

      expect(await readdir(project.agentsRoot)).toEqual([]);
      expect(catalog.current().available).toEqual([]);
    } finally { await project.close(); }
  });

  it("rejects a managed-root junction that resolves outside the project", async () => {
    const project = await localProject();
    const outside = await mkdtemp(path.join(os.tmpdir(), "myagent-agent-outside-"));
    try {
      await rm(project.agentsRoot, { recursive: true });
      await symlink(outside, project.agentsRoot, "junction");
      const catalog = new CatalogService(await loadCatalog(project.configPath));
      await expect(new CreateManagedAgentService(catalog).execute(input(catalog.revision())))
        .rejects.toMatchObject({ code: "unmanaged_agent_root" });
      expect(await readdir(outside)).toEqual([]);
    } finally { await project.close(); await rm(outside, { recursive: true, force: true }); }
  });

  it("rejects a lexically in-root workspace junction escape", async (context) => {
    const project = await localProject();
    const outside = await mkdtemp(path.join(os.tmpdir(), "myagent-workspace-outside-"));
    try {
      await writeFile(path.join(outside, "keep.txt"), "keep\n");
      const catalog = new CatalogService(await loadCatalog(project.configPath));
      let writes = 0;
      const service = new CreateManagedAgentService(catalog, {
        writeFile: async (file, content) => {
          await writeFile(file, content, { flag: "wx" });
          writes += 1;
          if (writes !== 3) return;
          try {
            await symlink(outside, path.join(path.dirname(file), "workspace"), "junction");
          } catch (error) {
            if (!hasCode(error, "EPERM") && !hasCode(error, "EACCES")) throw error;
            context.skip(`junction creation unavailable: ${String((error as Error).message)}`);
          }
        },
      });

      await expect(service.execute({
        ...input(catalog.revision()), workspace: "./workspace/child",
      })).rejects.toMatchObject({ code: "invalid_managed_agent" });

      expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe("keep\n");
      expect(await readdir(outside)).toEqual(["keep.txt"]);
    } finally { await project.close(); await rm(outside, { recursive: true, force: true }); }
  });
});

function input(expectedCatalogRevision: string) {
  return {
    id: "writer", displayName: "Writer", prompt: "Write clearly.\n", workspace: "./workspace",
    policy: { rules: [] }, expectedCatalogRevision,
  } as const;
}

async function localProject(options: { agentRoots?: readonly string[] } = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "myagent-managed-agent-"));
  const root = path.join(workspace, ".myagent");
  const agentsRoot = path.join(root, "agents");
  await mkdir(agentsRoot, { recursive: true });
  await mkdir(path.join(root, "skills"));
  const configPath = path.join(root, "myagent.yaml");
  await writeFile(configPath, stringifyYaml({
    version: 2,
    server: { bearerToken: { fromEnvironment: "RUN_TOKEN" }, adminToken: { fromEnvironment: "ADMIN_TOKEN" } },
    database: { path: "state.sqlite" }, agentRoots: options.agentRoots ?? ["agents"], skillRoots: ["skills"],
    toolEnvironmentAllowlist: [],
  }));
  return { workspace, root, agentsRoot, configPath, close: () => rm(workspace, { recursive: true, force: true }) };
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
