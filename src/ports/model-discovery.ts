import type { ProviderConnectionRevision } from "../domain/provider-connection.js";

export interface DiscoveryResult {
  readonly state: "fresh" | "empty" | "unsupported";
  readonly models: readonly { id: string; owner?: string; createdAt?: Date }[];
  readonly fetchedAt: Date;
}

export interface ModelDiscoveryLimits {
  readonly timeoutMs: number;
  readonly maxItems: number;
  readonly maxResponseBytes: number;
}

export interface ModelDiscoveryPort {
  discover(
    connection: ProviderConnectionRevision,
    limits: ModelDiscoveryLimits,
    signal: AbortSignal,
  ): Promise<DiscoveryResult>;
}
