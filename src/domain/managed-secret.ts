import type {
  ManagedSecretVersionId,
  ProviderConnectionRevisionId,
} from "./ids.js";

export interface ManagedSecretVersionMetadata {
  readonly versionId: ManagedSecretVersionId;
  readonly secretId: string;
  readonly purpose: "provider_api_key";
  readonly keyId: string;
  readonly state: "active" | "destroyed";
  readonly recordRevision: number;
  readonly createdAt: Date;
  readonly destroyedAt: Date | null;
}

export interface ManagedSecretKeyringState {
  readonly currentKeyId: string;
  readonly recordRevision: number;
  readonly updatedAt: Date;
}

export type SecretReferenceOwner =
  | { type: "provider_connection_revision"; id: ProviderConnectionRevisionId }
  | { type: "retained_run_snapshot"; id: string };
