import type { CliClient } from "../client.js";
import { writeJson, type CliWrite } from "../formatters.js";
export async function reconcileTool(client: CliClient, toolCallId: string, outcome: "succeeded" | "failed" | "retry", write: CliWrite): Promise<void> { writeJson(write, await client.request(`/v1/tool-calls/${encodeURIComponent(toolCallId)}/reconciliation`, { method: "POST", body: { outcome } })); }
