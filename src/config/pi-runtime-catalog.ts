import { getModel, getModels, getProviders } from "@mariozechner/pi-ai";

import type {
  PiRuntimeContract,
  ProviderCatalogCandidate,
  ProviderDriverId,
} from "../domain/pi-runtime.js";

export const PI_RUNTIME_VERSION = "0.73.1" as const;

const BEARER_HEADER_CATALOG_PROVIDERS = new Set(["openai", "deepseek"]);

const providerCatalogCandidates = freezeCandidates(buildCandidates());

export function listProviderCatalogCandidates(): readonly ProviderCatalogCandidate[] {
  return providerCatalogCandidates;
}

export function resolveProviderCatalogCandidate(
  candidateId: string,
): ProviderCatalogCandidate | undefined {
  const exact = providerCatalogCandidates.find(
    (candidate) => candidate.candidateId === candidateId,
  );
  if (exact !== undefined) return exact;

  // Unsupported providers are catalog-only: this wildcard supports explaining
  // their unavailable credential mode without selecting a runtime model.
  if (candidateId.endsWith(":any")) {
    const driverId = candidateId.slice(0, -":any".length) as ProviderDriverId;
    return providerCatalogCandidates.find(
      (candidate) =>
        candidate.driverId === driverId && candidate.credentialSupport === "unsupported",
    );
  }
  return undefined;
}

export function resolveProviderCatalogCandidateForRuntime(
  runtime: Omit<PiRuntimeContract, "kind">,
): ProviderCatalogCandidate | undefined {
  return providerCatalogCandidates.find(
    (candidate) => invocationMatches(candidate.invocation, runtime),
  );
}

function buildCandidates(): ProviderCatalogCandidate[] {
  const candidates: ProviderCatalogCandidate[] = [];
  for (const provider of getProviders()) {
    const catalogProviderId = String(provider);
    const driverId = `pi/${catalogProviderId}` as ProviderDriverId;
    const credentialSupport = BEARER_HEADER_CATALOG_PROVIDERS.has(catalogProviderId)
      ? "bearer"
      : "unsupported";

    for (const listedModel of getModels(provider)) {
      const model = getModel(provider, listedModel.id as never);
      if (model === undefined) continue;
      const compatibility = primitiveCompatibility(model.compat);
      const invocation: Omit<PiRuntimeContract, "kind"> = {
        piVersion: PI_RUNTIME_VERSION,
        driverId,
        catalogProviderId,
        api: model.api,
        providerCompatibilityContract: "none",
        modelId: model.id,
        contextWindow: model.contextWindow,
        ...(model.maxTokens > 0 ? { maxOutputTokens: model.maxTokens } : {}),
        compatibility,
      };
      candidates.push({
        candidateId: `${driverId}:${model.id}`,
        driverId,
        displayName: model.name,
        modelId: model.id,
        invocation,
        credentialSupport,
      });
    }
  }
  appendDeepSeekResponsesCandidate(candidates);
  return candidates;
}

function appendDeepSeekResponsesCandidate(candidates: ProviderCatalogCandidate[]): void {
  const nativeCandidate = candidates.find(
    (candidate) => candidate.candidateId === "pi/deepseek:deepseek-v4-flash",
  );
  if (nativeCandidate === undefined) return;

  candidates.push({
    ...nativeCandidate,
    candidateId: "pi/deepseek:deepseek-v4-flash-responses",
    displayName: "DeepSeek V4 Flash (Responses)",
    invocation: {
      ...nativeCandidate.invocation,
      api: "openai-responses",
      providerCompatibilityContract: "deepseek-responses-v1",
    },
  });
}

function invocationMatches(
  candidate: Omit<PiRuntimeContract, "kind">,
  runtime: Omit<PiRuntimeContract, "kind">,
): boolean {
  const providerCompatibilityContract =
    runtime.providerCompatibilityContract ?? "none";
  return candidate.piVersion === runtime.piVersion &&
    candidate.driverId === runtime.driverId &&
    candidate.catalogProviderId === runtime.catalogProviderId &&
    candidate.api === runtime.api &&
    candidate.providerCompatibilityContract === providerCompatibilityContract &&
    candidate.modelId === runtime.modelId &&
    candidate.contextWindow === runtime.contextWindow &&
    candidate.maxOutputTokens === runtime.maxOutputTokens &&
    primitiveRecordsMatch(candidate.compatibility, runtime.compatibility);
}

function primitiveRecordsMatch(
  left: Readonly<Record<string, boolean | number | string>>,
  right: Readonly<Record<string, boolean | number | string>>,
): boolean {
  const leftEntries = Object.entries(left);
  if (leftEntries.length !== Object.keys(right).length) return false;
  return leftEntries.every(([key, value]) => right[key] === value);
}

function primitiveCompatibility(
  compatibility: Record<string, unknown> | undefined,
): Readonly<Record<string, boolean | number | string>> {
  const values: Record<string, boolean | number | string> = {};
  for (const [key, value] of Object.entries(compatibility ?? {})) {
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
      values[key] = value;
    }
  }
  return Object.freeze(values);
}

function freezeCandidates(
  candidates: readonly ProviderCatalogCandidate[],
): readonly ProviderCatalogCandidate[] {
  return Object.freeze(candidates.map((candidate) => Object.freeze({
    ...candidate,
    invocation: Object.freeze({ ...candidate.invocation }),
  })));
}
