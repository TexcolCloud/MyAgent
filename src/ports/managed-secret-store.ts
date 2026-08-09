import type { ManagedSecretVersionId } from "../domain/ids.js";
import type { ManagedSecretVersionMetadata } from "../domain/managed-secret.js";

export interface CreateManagedSecretVersionInput {
  readonly versionId: ManagedSecretVersionId;
  readonly secretId: string;
  readonly purpose: "provider_api_key";
  readonly plaintext: string;
  readonly now: Date;
}

export interface DestroyManagedSecretVersionInput {
  readonly versionId: ManagedSecretVersionId;
  readonly expectedRevision: number;
  readonly now: Date;
}

export interface RotateManagedSecretKeyInput {
  readonly expectedRevision: number;
  readonly now: Date;
}

export interface ManagedSecretRotationResult {
  readonly reencrypted: number;
  readonly currentKeyId: string;
  readonly recordRevision: number;
}

export interface ManagedSecretStore {
  createVersion(input: CreateManagedSecretVersionInput): ManagedSecretVersionMetadata;
  resolve(versionId: ManagedSecretVersionId): string;
  destroy(input: DestroyManagedSecretVersionInput): ManagedSecretVersionMetadata;
  rotateMasterKey(input: RotateManagedSecretKeyInput): ManagedSecretRotationResult;
}
