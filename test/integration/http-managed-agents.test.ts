import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { stringify as stringifyYaml } from "yaml";
import { describe, expect, it, vi } from "vitest";

import { CreateManagedAgentService } from "../../src/application/create-managed-agent.js";
import { loadCatalog } from "../../src/config/catalog-loader.js";
import { CatalogService } from "../../src/config/catalog-service.js";
import { createHttpApp } from "../../src/interfaces/http/app.js";
import { TuiClient } from "../../src/interfaces/tui/tui-client.js";

describe("managed Agent HTTP API", () => {
  it("creates only through authenticated typed HTTP and returns an unassigned Agent", async () => {
    const project = await localProject();
    const catalog = new CatalogService(await loadCatalog(project.configPath));
    const assignmentSync = vi.fn();
    const app = createHttpApp({ bearerToken: "run-token", adminToken: "admin-token", catalog,
      createManagedAgents: new CreateManagedAgentService(catalog, { afterReload: assignmentSync }), });
    try {
      const unauthorized = await app.inject({ method: "POST", url: "/v1/admin/agents", remoteAddress: "127.0.0.1", payload: input(catalog.revision()) });
      expect(unauthorized.statusCode).toBe(401);
      const client = new TuiClient({ apiUrl: "http://local.test", runToken: "run-token", adminToken: "admin-token",
        fetcher: injectFetcher(app), });
      const before = await client.listAgents();

      expect(before.catalogRevision).toMatch(/^catalog_/u);
      const created = await client.createManagedAgent(input(before.catalogRevision!));

      expect(created.agent).toMatchObject({ id: "writer", displayName: "Writer", assignment: { state: "unassigned" } });
      expect(assignmentSync).toHaveBeenCalledOnce();
      expect(await client.listAgents()).toMatchObject({ agents: [expect.objectContaining({ id: "writer" })] });
    } finally { await app.close(); await project.close(); }
  });

  it("returns a typed reload-required conflict and does not retry stale creation", async () => {
    const project = await localProject();
    const catalog = new CatalogService(await loadCatalog(project.configPath));
    const execute = vi.spyOn(CreateManagedAgentService.prototype, "execute");
    const app = createHttpApp({ bearerToken: "run-token", adminToken: "admin-token", catalog,
      createManagedAgents: new CreateManagedAgentService(catalog), });
    try {
      const client = new TuiClient({ apiUrl: "http://local.test", runToken: "run-token", adminToken: "admin-token", fetcher: injectFetcher(app) });
      const error = await client.createManagedAgent(input("catalog_stale")).then(() => undefined, (value: unknown) => value);
      expect(error).toMatchObject({ status: 409, code: "revision_conflict", reloadRequired: true });
      expect(execute).toHaveBeenCalledOnce();
    } finally { execute.mockRestore(); await app.close(); await project.close(); }
  });
});

function input(expectedCatalogRevision: string) { return { id: "writer", displayName: "Writer", prompt: "Write clearly.\n", workspace: "./workspace", policy: { rules: [] }, expectedCatalogRevision } as const; }
function injectFetcher(app: ReturnType<typeof createHttpApp>): typeof fetch { return async (request, init) => { const url = new URL(String(request)); const response = await app.inject({ method: (init?.method ?? "GET") as "GET" | "POST", url: url.pathname, remoteAddress: "127.0.0.1", headers: Object.fromEntries(new Headers(init?.headers).entries()), ...(init?.body === undefined ? {} : { payload: String(init.body) }) }); return new Response(response.payload, { status: response.statusCode, headers: { "content-type": response.headers["content-type"] ?? "application/json" } }); }; }
async function localProject() { const workspace = await mkdtemp(path.join(os.tmpdir(), "myagent-http-agent-")); const root = path.join(workspace, ".myagent"); await mkdir(path.join(root, "agents"), { recursive: true }); await mkdir(path.join(root, "skills")); const configPath = path.join(root, "myagent.yaml"); await writeFile(configPath, stringifyYaml({ version: 2, server: { bearerToken: { fromEnvironment: "RUN_TOKEN" }, adminToken: { fromEnvironment: "ADMIN_TOKEN" } }, database: { path: "state.sqlite" }, agentRoots: ["agents"], skillRoots: ["skills"], toolEnvironmentAllowlist: [] })); return { configPath, close: () => rm(workspace, { recursive: true, force: true }) }; }
