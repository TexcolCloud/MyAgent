import type { ProviderAuth } from "../domain/provider-connection.js";

export interface ProviderHttpConnectionRuntime {
  readonly baseUrl: string;
  readonly auth: ProviderAuth;
  readonly allowInsecureHttp: boolean;
}

export interface ProviderHttpTransportInput {
  readonly connection: ProviderHttpConnectionRuntime;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export interface ProviderHttpTransport {
  createFetch(input: ProviderHttpTransportInput): typeof fetch;
}
