import type { CliClient } from "../client.js";
import { writeJson, type CliWrite } from "../formatters.js";

export type ProviderAuthInput =
  | { readonly type: "none" }
  | { readonly type: "environment"; readonly fromEnvironment: string }
  | { readonly type: "api_key"; readonly apiKey: string };

export interface ProviderCreateInput {
  readonly slug: string;
  readonly displayName: string;
  readonly kind?: "openai" | "deepseek" | "openai_compatible";
  readonly driverId?: string;
  readonly baseUrl?: string;
  readonly auth: ProviderAuthInput;
  readonly allowInsecureHttp?: boolean;
  readonly protocolPreference?: "chat_completions" | "responses";
}

export async function addProvider(
  client: CliClient,
  input: ProviderCreateInput,
  write: CliWrite,
): Promise<unknown> {
  const result = await client.request("/v1/admin/provider-connections", {
    authority: "admin",
    method: "POST",
    body: providerBody(input),
  });
  writeJson(write, result);
  return result;
}

export async function updateProvider(
  client: CliClient,
  providerId: string,
  input: Omit<ProviderCreateInput, "slug" | "kind"> & { readonly expectedRevision: number },
  write: CliWrite,
): Promise<unknown> {
  const result = await client.request(`/v1/admin/provider-connections/${encodeURIComponent(providerId)}/revisions`, {
    authority: "admin",
    method: "POST",
    body: { expectedRevision: input.expectedRevision, ...providerBody(input) },
  });
  writeJson(write, result);
  return result;
}

export async function listProviders(client: CliClient, write: CliWrite): Promise<void> {
  writeJson(write, await client.request("/v1/admin/provider-connections", { authority: "admin" }));
}

export async function discoverProviderModels(
  client: CliClient,
  revisionId: string,
  expectedRevision: number,
  write: CliWrite,
): Promise<number> {
  const result = await client.request<{
    readonly state?: string;
    readonly error?: { readonly code: string; readonly traceId: string } | null;
  }>(`/v1/admin/provider-connection-revisions/${encodeURIComponent(revisionId)}/discover`, {
    authority: "admin",
    method: "POST",
    body: { expectedRevision },
  });
  if (result.state === "failed" && result.error != null) {
    writeJson(write, {
      code: result.error.code,
      detail: "Provider model discovery failed.",
      traceId: result.error.traceId,
    });
    return 5;
  }
  writeJson(write, result);
  return 0;
}

export async function promoteProvider(
  client: CliClient,
  providerId: string,
  revisionId: string,
  expectedRevision: number,
  write: CliWrite,
): Promise<unknown> {
  const result = await client.request(`/v1/admin/provider-connections/${encodeURIComponent(providerId)}/promotions`, {
    authority: "admin",
    method: "POST",
    body: { connectionRevisionId: revisionId, expectedRevision },
  });
  writeJson(write, result);
  return result;
}

export async function retireProvider(
  client: CliClient,
  providerId: string,
  expectedRevision: number,
  write: CliWrite,
): Promise<void> {
  writeJson(write, await client.request(`/v1/admin/provider-connections/${encodeURIComponent(providerId)}/retirement`, {
    authority: "admin",
    method: "POST",
    body: { expectedRevision },
  }));
}

function providerBody(input: Omit<ProviderCreateInput, "slug" | "kind"> | ProviderCreateInput): Record<string, unknown> {
  const { auth, ...rest } = input;
  if (auth.type === "api_key") {
    return { ...rest, auth: { type: "api_key" }, apiKey: auth.apiKey };
  }
  return { ...rest, auth };
}
