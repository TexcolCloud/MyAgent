import { DomainError } from "../domain/errors.js";
import type { SecretRef } from "../config/secret-ref.js";
import type { SecretResolver } from "../ports/secret-resolver.js";

export class EnvironmentSecretResolver implements SecretResolver {
  constructor(
    private readonly environment: Readonly<Record<string, string | undefined>> =
      process.env,
  ) {}

  resolve(reference: SecretRef): string {
    const value = this.environment[reference.fromEnvironment];
    if (value === undefined || value.length === 0) {
      throw new DomainError(
        "secret_unavailable",
        `secret_unavailable: ${reference.fromEnvironment}`,
      );
    }

    return value;
  }
}
