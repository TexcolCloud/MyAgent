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

export function isValidProviderCompatibilityRuntime(
  runtime: PiRuntimeContract,
): boolean {
  if (runtime.providerCompatibilityContract === "none") return true;
  if (runtime.providerCompatibilityContract !== "deepseek-responses-v1") return false;
  return runtime.kind === "pi_ai" &&
    runtime.piVersion === "0.73.1" &&
    runtime.driverId === "pi/deepseek" &&
    runtime.catalogProviderId === "deepseek" &&
    runtime.api === "openai-responses" &&
    runtime.modelId === "deepseek-v4-flash" &&
    runtime.contextWindow === 1_000_000 &&
    runtime.maxOutputTokens === 384_000 &&
    primitiveRecordsMatch(runtime.compatibility, {
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
    });
}

function primitiveRecordsMatch(
  left: Readonly<Record<string, boolean | number | string>>,
  right: Readonly<Record<string, boolean | number | string>>,
): boolean {
  const entries = Object.entries(left);
  return entries.length === Object.keys(right).length &&
    entries.every(([key, value]) => right[key] === value);
}
