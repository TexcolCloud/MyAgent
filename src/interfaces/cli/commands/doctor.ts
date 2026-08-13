import type { DiagnosticReport } from "../../../application/collect-diagnostics.js";
import type { CliClient } from "../client.js";
import { writeJson, type CliWrite } from "../formatters.js";

export async function doctor(client: CliClient, write: CliWrite, json: boolean): Promise<void> {
  const report = await client.request<DiagnosticReport>("/v1/admin/diagnostics", { authority: "admin" });
  if (json) {
    writeJson(write, report);
    return;
  }
  for (const check of report.checks) write(`${check.id}: ${check.status} (${check.detail})`);
}
