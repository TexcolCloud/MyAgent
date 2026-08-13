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

  it("rejects workspace symlink escape", async () => {
    const project = await localProject();
    try {
      const outside = await mkdtemp(path.join(os.tmpdir(), "myagent-agent-outside-"));
      await symlink(outside, path.join(project.agentsRoot, "escaped-workspace"), "junction");
      const catalog = new CatalogService(await loadCatalog(project.configPath));
      await expect(new CreateManagedAgentService(catalog).execute({
        ...input(catalog.revision()), workspace: "../escaped-workspace",
      })).rejects.toMatchObject({ code: "invalid_managed_agent" });
      await rm(outside, { recursive: true, force: true });
    } finally { await project.close(); }
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
