import type { ProviderConnectionRevision } from "../domain/provider-connection.js";

export interface ProviderHttpTransportInput {
  readonly connection: ProviderConnectionRevision;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export interface ProviderHttpTransport {
  createFetch(input: ProviderHttpTransportInput): typeof fetch;
}
