import type { CliClient } from "../client.js";
import { writeJson, type CliWrite } from "../formatters.js";
export async function listAgents(client: CliClient, write: CliWrite): Promise<void> { writeJson(write, await client.request("/v1/agents")); }

export async function setAgentModel(
  client: CliClient,
  agentId: string,
  profileRevisionId: string,
  expectedRevision: number,
  write: CliWrite,
): Promise<void> {
  writeJson(write, await client.request(`/v1/admin/agents/${encodeURIComponent(agentId)}/model-assignment`, {
    authority: "admin",
    method: "PUT",
    body: { modelProfileRevisionId: profileRevisionId, expectedRevision },
  }));
}
