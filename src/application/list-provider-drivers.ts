import {
  PI_RUNTIME_VERSION,
  listProviderCatalogCandidates,
} from "../config/pi-runtime-catalog.js";
import { DomainError } from "../domain/errors.js";
import type {
  ProviderCatalogCandidate,
  ProviderDriverId,
} from "../domain/pi-runtime.js";

export interface ProviderDriverCandidateView {
  readonly candidateId: string;
  readonly displayName: string;
  readonly modelId: string;
  readonly credentialSupport: "bearer" | "none" | "unsupported";
}

export interface ProviderDriverView {
  readonly driverId: ProviderDriverId;
  readonly candidates: readonly ProviderDriverCandidateView[];
}

export interface ProviderDriverCatalogView {
  readonly piVersion: typeof PI_RUNTIME_VERSION;
  readonly drivers: readonly ProviderDriverView[];
}

export class ListProviderDriversService {
  list(): ProviderDriverCatalogView {
    const drivers = new Map<ProviderDriverId, ProviderDriverCandidateView[]>();
    for (const candidate of listProviderCatalogCandidates()) {
      const candidates = drivers.get(candidate.driverId) ?? [];
      candidates.push({
        candidateId: candidate.candidateId,
        displayName: candidate.displayName,
        modelId: candidate.modelId,
        credentialSupport: candidate.credentialSupport,
      });
      drivers.set(candidate.driverId, candidates);
    }
    return {
      piVersion: PI_RUNTIME_VERSION,
      drivers: [
        ...[...drivers].map(([driverId, candidates]) => ({ driverId, candidates })),
        { driverId: "pi/openai-compatible", candidates: [] },
      ],
    };
  }

  resolveSupportedDriver(driverId: ProviderDriverId): ProviderDriverId {
    if (driverId === "pi/openai-compatible") return driverId;
    const candidates = listProviderCatalogCandidates().filter(
      (candidate) => candidate.driverId === driverId,
    );
    if (
      candidates.length === 0 ||
      candidates.every((candidate) => candidate.credentialSupport === "unsupported")
    ) {
      throw new DomainError("invalid_provider_connection");
    }
    return driverId;
  }

  resolveSupportedCandidate(candidateId: string): ProviderCatalogCandidate {
    const candidate = listProviderCatalogCandidates().find(
      (entry) => entry.candidateId === candidateId,
    );
    if (candidate === undefined || candidate.credentialSupport === "unsupported") {
      throw new DomainError("invalid_model_profile");
    }
    return candidate;
  }
}
