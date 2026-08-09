import { assertPurgeAllowed } from "../domain/model-profile.js";
import type { ManagedSecretVersionId } from "../domain/ids.js";
import type { ManagedSecretVersionMetadata } from "../domain/managed-secret.js";
import type { Clock } from "../ports/clock.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type {
  ManagedSecretRotationResult,
  ManagedSecretStore,
} from "../ports/managed-secret-store.js";
import type { ModelRegistryStore } from "../ports/model-registry-store.js";

export class ManageSecretsService {
  constructor(
    private readonly store: ManagedSecretStore,
    private readonly registry: Pick<ModelRegistryStore, "inspectSecretReferences">,
    private readonly clock: Clock,
    private readonly ids: Pick<IdGenerator, "managedSecretVersionId">,
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
    const references = this.registry.inspectSecretReferences(input.versionId);
    assertPurgeAllowed(references.length);
    return this.store.destroy({ ...input, now: this.clock.now() });
  }

  rotateMasterKey(input: {
    readonly expectedRevision: number;
  }): ManagedSecretRotationResult {
    return this.store.rotateMasterKey({ ...input, now: this.clock.now() });
  }
}
