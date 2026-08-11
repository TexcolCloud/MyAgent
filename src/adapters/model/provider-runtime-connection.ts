import type { EffectiveModelRuntime } from "../../domain/agent-revision.js";
import type { ProviderHttpConnectionRuntime } from "../../ports/provider-http-transport.js";

export function providerRuntimeConnection(
  model: EffectiveModelRuntime,
): ProviderHttpConnectionRuntime {
  return {
    baseUrl: model.baseUrl,
    auth: model.providerAuth,
    allowInsecureHttp: model.allowInsecureHttp === true,
  };
}
