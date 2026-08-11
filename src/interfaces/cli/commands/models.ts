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
  readonly fallbackVerificationId?: string | null;
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
  const result = await pollVerification(
    client,
    queued.operationUrl,
    revisionId,
    sleep,
  );
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
  initialProfileRevisionId: string,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<VerificationView> {
  let current = verificationTarget(operationUrl, initialProfileRevisionId);
  const visited = new Set<string>();
  for (let depth = 0; depth < MAX_VERIFICATION_CHAIN_LENGTH; depth += 1) {
    if (visited.has(current.verificationId)) throw invalidControlPlaneResponse();
    visited.add(current.verificationId);
    let result: VerificationView;
    for (;;) {
      result = await client.request<VerificationView>(current.operationUrl, {
        authority: "admin",
      });
      assertVerificationIdentity(result, current);
      if (result.status !== "queued" && result.status !== "running") break;
      await sleep(250);
    }
    const fallback = fallbackTarget(result);
    if (fallback === null) return result;
    current = fallback;
  }
  throw invalidControlPlaneResponse();
}

interface VerificationTarget {
  readonly verificationId: string;
  readonly profileRevisionId: string;
  readonly operationUrl: string;
}

const MAX_VERIFICATION_CHAIN_LENGTH = 8;
const VERIFICATION_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "passed",
  "failed",
  "cancelled",
]);
const VERIFICATION_ID_PATTERN = /^ver_[A-Za-z0-9-]{1,196}$/u;
const PROFILE_REVISION_ID_PATTERN = /^mpr_[A-Za-z0-9-]{1,196}$/u;
const VERIFICATION_OPERATION_PATTERN = /^\/v1\/admin\/model-verifications\/(ver_[A-Za-z0-9-]{1,196})$/u;

function verificationTarget(
  operationUrl: string,
  profileRevisionId: string,
): VerificationTarget {
  const match = VERIFICATION_OPERATION_PATTERN.exec(operationUrl);
  if (match?.[1] === undefined || !PROFILE_REVISION_ID_PATTERN.test(profileRevisionId)) {
    throw invalidControlPlaneResponse();
  }
  return {
    verificationId: match[1],
    profileRevisionId,
    operationUrl,
  };
}

function fallbackTarget(result: VerificationView): VerificationTarget | null {
  const verificationId = result.fallbackVerificationId ?? null;
  const profileRevisionId = result.fallbackProfileRevisionId ?? null;
  if (verificationId === null && profileRevisionId === null) return null;
  if (
    result.status !== "failed" ||
    verificationId === null ||
    profileRevisionId === null ||
    !VERIFICATION_ID_PATTERN.test(verificationId) ||
    !PROFILE_REVISION_ID_PATTERN.test(profileRevisionId)
  ) {
    throw invalidControlPlaneResponse();
  }
  return {
    verificationId,
    profileRevisionId,
    operationUrl: `/v1/admin/model-verifications/${verificationId}`,
  };
}

function assertVerificationIdentity(
  result: VerificationView,
  expected: VerificationTarget,
): void {
  if (
    result.verificationId !== expected.verificationId ||
    result.profileRevisionId !== expected.profileRevisionId ||
    !VERIFICATION_STATUSES.has(result.status)
  ) {
    throw invalidControlPlaneResponse();
  }
}

function invalidControlPlaneResponse(): Error {
  return new Error("invalid_control_plane_response");
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
