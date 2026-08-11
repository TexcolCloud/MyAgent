import type { CliClient } from "../client.js";
import type { CliWrite } from "../formatters.js";
import { writeVerificationResult, type VerificationView } from "./models.js";

export async function getVerification(client: CliClient, verificationId: string, write: CliWrite): Promise<number> {
  return writeVerificationResult(
    await client.request<VerificationView>(`/v1/admin/model-verifications/${encodeURIComponent(verificationId)}`, { authority: "admin" }),
    write,
  );
}
