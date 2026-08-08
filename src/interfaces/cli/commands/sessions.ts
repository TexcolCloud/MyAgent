import type { CliClient } from "../client.js";
import { writeJson, type CliWrite } from "../formatters.js";
export async function listSessions(client: CliClient, agentId: string, sessionKey: string, write: CliWrite): Promise<void> { writeJson(write, await client.request(`/v1/sessions?agentId=${encodeURIComponent(agentId)}&sessionKey=${encodeURIComponent(sessionKey)}`)); }
export async function deleteSession(client: CliClient, sessionId: string, write: CliWrite): Promise<void> { await client.request(`/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }); writeJson(write, { sessionId, deleted: true }); }
