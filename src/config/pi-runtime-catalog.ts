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
  driverId: ProviderDriverId,
  modelId: string,
): ProviderCatalogCandidate | undefined {
  const exact = providerCatalogCandidates.find(
    (candidate) => candidate.driverId === driverId && candidate.modelId === modelId,
  );
  if (exact !== undefined) return exact;

  // Unsupported providers are catalog-only: this wildcard supports explaining
  // their unavailable credential mode without selecting a runtime model.
  if (modelId === "any") {
    return providerCatalogCandidates.find(
      (candidate) =>
        candidate.driverId === driverId && candidate.credentialSupport === "unsupported",
    );
  }
  return undefined;
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
  return candidates;
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
