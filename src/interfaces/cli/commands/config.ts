import { loadCatalog } from "../../../config/catalog-loader.js";
import type { CliClient } from "../client.js";
import { writeJson, type CliWrite } from "../formatters.js";

export async function validateConfig(configPath: string, write: CliWrite): Promise<void> {
  const catalog = await loadCatalog(configPath);
  writeJson(write, { agents: catalog.available.map((agent) => ({ id: agent.id, revisionId: agent.revision.revisionId })), unavailable: catalog.unavailable.map((agent) => ({ id: agent.id, code: agent.code })) });
}

export async function reloadConfig(client: CliClient, write: CliWrite): Promise<void> {
  writeJson(write, await client.request("/v1/config/reload", { method: "POST" }));
}
