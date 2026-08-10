import { DomainError } from "../domain/errors.js";
import type { ManagedSecretVersionId } from "../domain/ids.js";
import type { ManagedSecretVersionMetadata } from "../domain/managed-secret.js";
import type { Clock } from "../ports/clock.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type {
  ManagedSecretRotationResult,
  ManagedSecretStore,
} from "../ports/managed-secret-store.js";
import type { ModelRegistryStore } from "../ports/model-registry-store.js";

export interface ManagedSecretTransaction {
  run<Result>(operation: () => Result): Result;
}

export class ManageSecretsService {
  constructor(
    private readonly store: ManagedSecretStore,
    private readonly registry: Pick<ModelRegistryStore, "inspectSecretReferences">,
    private readonly clock: Clock,
    private readonly ids: Pick<IdGenerator, "managedSecretVersionId">,
    private readonly transaction: ManagedSecretTransaction,
  ) {}

  createProviderApiKey(input: {
    readonly secretId: string;
    readonly plaintext: string;
  }): ManagedSecretVersionMetadata {
    return this.store.createVersion({
      versionId: this.ids.managedSecretVersionId(),
      secretId: input.secretId,
      purpose: "provider_api_key",
      plaintext: input.plaintext,
      now: this.clock.now(),
    });
  }

  destroyVersion(input: {
    readonly versionId: ManagedSecretVersionId;
    readonly expectedRevision: number;
  }): ManagedSecretVersionMetadata {
    return this.transaction.run(() => {
      this.store.assertActiveVersion(input);
      const references = this.registry.inspectSecretReferences(input.versionId);
      if (references.length > 0) {
        throw new DomainError("resource_in_use", "resource_in_use", {
          ownerCategories: [
            ...new Set(references.map((reference) => reference.type)),
          ],
        });
      }
      return this.store.destroy({ ...input, now: this.clock.now() });
    });
  }

  assertVersionActive(versionId: ManagedSecretVersionId): void {
    this.transaction.run(() => {
      this.store.assertActiveVersion({ versionId });
    });
  }

  rotateMasterKey(input: {
    readonly expectedRevision: number;
  }): ManagedSecretRotationResult {
    return this.store.rotateMasterKey({ ...input, now: this.clock.now() });
  }
}
