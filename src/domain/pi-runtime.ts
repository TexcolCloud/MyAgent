export type ProviderDriverId = `pi/${string}`;
export type ProviderCompatibilityContract = "none" | "deepseek-responses-v1";

export interface PiRuntimeContract {
  readonly kind: "pi_ai";
  readonly piVersion: "0.73.1";
  readonly driverId: ProviderDriverId;
  readonly catalogProviderId: string;
  readonly api: string;
  readonly providerCompatibilityContract: ProviderCompatibilityContract;
  readonly modelId: string;
  readonly contextWindow: number;
  readonly maxOutputTokens?: number;
  readonly compatibility: Readonly<Record<string, boolean | number | string>>;
}

export interface ProviderCatalogCandidate {
  readonly candidateId: string;
  readonly driverId: ProviderDriverId;
  readonly displayName: string;
  readonly modelId: string;
  readonly invocation: Omit<PiRuntimeContract, "kind">;
  readonly credentialSupport: "bearer" | "none" | "unsupported";
}
