import type { ModelRegistryStore } from "../../src/ports/model-registry-store.js";

export const noOpProviderHealthSink = {
  recordProviderHealth(): void {},
} satisfies Pick<ModelRegistryStore, "recordProviderHealth">;
