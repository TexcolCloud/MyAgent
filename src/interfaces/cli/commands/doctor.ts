import type { DiagnosticReport } from "../../../application/collect-diagnostics.js";
import type { CliClient } from "../client.js";
import { writeJson, type CliWrite } from "../formatters.js";
import { diagnosticsResponseSchema } from "../../http/schemas.js";

export async function doctor(client: CliClient, write: CliWrite, json: boolean): Promise<boolean> {
  const response = await client.request<unknown>("/v1/admin/diagnostics", { authority: "admin" });
  const parsed = diagnosticsResponseSchema.safeParse(response);
  if (!parsed.success) throw new Error("invalid_diagnostic_report");
  const report: DiagnosticReport = parsed.data;
  if (json) {
    writeJson(write, report);
    return report.checks.every((check) => check.status === "ok");
  }
  for (const check of report.checks) write(`${check.id}: ${check.status} (${check.detail})`);
  return report.checks.every((check) => check.status === "ok");
}
