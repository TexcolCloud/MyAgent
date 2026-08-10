import type { CliClient } from "../client.js";
import { writeJson, type CliWrite } from "../formatters.js";

export interface ModelCreateInput {
  readonly slug: string;
  readonly displayName: string;
  readonly connectionRevisionId: string;
  readonly modelId: string;
  readonly protocol: "auto" | "chat_completions" | "responses";
  readonly maxInputTokens?: number;
  readonly contextWindowSource?: "preset" | "operator" | "assumed_32768";
  readonly manualEntryAcknowledged?: boolean;
}

export interface VerificationView {
  readonly verificationId: string;
  readonly profileRevisionId: string;
  readonly status: "queued" | "running" | "passed" | "failed" | "cancelled";
  readonly resultCode: string | null;
  readonly safeStatus?: number | null;
  readonly capabilities: readonly string[];
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly traceId: string;
  readonly fallbackProfileRevisionId?: string | null;
}

export async function createModel(client: CliClient, input: ModelCreateInput, write: CliWrite): Promise<unknown> {
  const result = await client.request("/v1/admin/model-profiles", {
    authority: "admin",
    method: "POST",
    body: input,
  });
  writeJson(write, result);
  return result;
}

export async function verifyModel(
  client: CliClient,
  revisionId: string,
  expectedRevision: number,
  sleep: (milliseconds: number) => Promise<void>,
  write: CliWrite,
): Promise<number> {
  const queued = await client.request<{ operationUrl: string }>(`/v1/admin/model-profile-revisions/${encodeURIComponent(revisionId)}/verifications`, {
    authority: "admin",
    method: "POST",
    body: { expectedRevision, capabilityBaseline: "text_and_single_tool_call_v1" },
  });
  const result = await pollVerification(client, queued.operationUrl, sleep);
  return writeVerificationResult(result, write);
}

export function writeVerificationResult(result: VerificationView, write: CliWrite): number {
  if (result.status === "failed") {
    writeJson(write, {
      code: result.resultCode ?? "verification_failed",
      detail: "Model verification failed.",
      traceId: result.traceId,
    });
    return 5;
  }
  writeJson(write, result);
  return 0;
}

export async function pollVerification(
  client: CliClient,
  operationUrl: string,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<VerificationView> {
  for (;;) {
    const result = await client.request<VerificationView>(operationUrl, { authority: "admin" });
    if (result.status !== "queued" && result.status !== "running") return result;
    await sleep(250);
  }
}

export async function promoteModel(client: CliClient, profileId: string, revisionId: string, expectedRevision: number, write: CliWrite): Promise<void> {
  writeJson(write, await client.request(`/v1/admin/model-profiles/${encodeURIComponent(profileId)}/promotions`, {
    authority: "admin",
    method: "POST",
    body: { profileRevisionId: revisionId, expectedRevision },
  }));
}

export async function listModels(client: CliClient, write: CliWrite): Promise<void> {
  writeJson(write, await client.request("/v1/admin/model-profiles", { authority: "admin" }));
}

export async function retireModel(client: CliClient, profileId: string, expectedRevision: number, write: CliWrite): Promise<void> {
  writeJson(write, await client.request(`/v1/admin/model-profiles/${encodeURIComponent(profileId)}/retirement`, {
    authority: "admin",
    method: "POST",
    body: { expectedRevision },
  }));
}

export async function setDefaultModel(client: CliClient, profileId: string, expectedRevision: number, write: CliWrite): Promise<void> {
  writeJson(write, await client.request("/v1/admin/default-model-profile", {
    authority: "admin",
    method: "PUT",
    body: { profileId, expectedRevision },
  }));
}
