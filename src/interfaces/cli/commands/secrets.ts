import type { CliClient } from "../client.js";
import { writeJson, type CliWrite } from "../formatters.js";

export async function rotateMasterKey(client: CliClient, expectedRevision: number, write: CliWrite): Promise<void> {
  writeJson(write, await client.request("/v1/admin/managed-secrets/master-key-rotation", {
    authority: "admin",
    method: "POST",
    body: { expectedRevision },
  }));
}
