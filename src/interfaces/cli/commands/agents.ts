import type { CliClient } from "../client.js";
import { writeJson, type CliWrite } from "../formatters.js";
export async function listAgents(client: CliClient, write: CliWrite): Promise<void> { writeJson(write, await client.request("/v1/agents")); }
