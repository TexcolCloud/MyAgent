import type { CliClient } from "../client.js";
import { writeJson, type CliWrite } from "../formatters.js";
export async function createBackup(client: CliClient, destination: string, write: CliWrite): Promise<void> { writeJson(write, await client.request("/v1/backups", { method: "POST", body: { destination } })); }
