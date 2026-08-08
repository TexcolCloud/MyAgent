import type { CliClient } from "../client.js";
import { writeJson, type CliWrite } from "../formatters.js";
export async function listApprovals(client: CliClient, write: CliWrite): Promise<void> { writeJson(write, await client.request("/v1/approvals?status=pending")); }
export async function decideApproval(client: CliClient, approvalId: string, decision: "approve" | "deny", write: CliWrite): Promise<void> { writeJson(write, await client.request(`/v1/approvals/${encodeURIComponent(approvalId)}/decision`, { method: "POST", body: { decision } })); }
