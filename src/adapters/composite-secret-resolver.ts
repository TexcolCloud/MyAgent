import type { SecretRef } from "../config/secret-ref.js";
import type { DynamicRedactionRegistry } from "../observability/redactor.js";
import type { ManagedSecretStore } from "../ports/managed-secret-store.js";
import type { SecretResolver } from "../ports/secret-resolver.js";

export class CompositeSecretResolver implements SecretResolver {
  constructor(
    private readonly environment: SecretResolver,
    private readonly managed: Pick<ManagedSecretStore, "resolve">,
    private readonly redactionRegistry: DynamicRedactionRegistry,
  ) {}

  resolve(reference: SecretRef): string {
    const value = "fromEnvironment" in reference
      ? this.environment.resolve(reference)
      : this.managed.resolve(reference.managedSecretVersionId);
    if (value.length > 0) this.redactionRegistry.register(value);
    return value;
  }
}
