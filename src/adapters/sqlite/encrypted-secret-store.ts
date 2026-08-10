import canonicalizeModule from "canonicalize";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { ApplicationError, DomainError } from "../../domain/errors.js";
import type { ManagedSecretVersionId } from "../../domain/ids.js";
import type { ManagedSecretVersionMetadata } from "../../domain/managed-secret.js";
import type {
  AssertManagedSecretVersionInput,
  CreateManagedSecretVersionInput,
  DestroyManagedSecretVersionInput,
  ManagedSecretRotationResult,
  ManagedSecretStore,
  RotateManagedSecretKeyInput,
} from "../../ports/managed-secret-store.js";
import { withImmediateTransaction } from "./database.js";

export interface ManagedSecretKeyEnvironment {
  readonly MYAGENT_MASTER_KEY?: string;
  readonly MYAGENT_PREVIOUS_MASTER_KEY?: string;
}

interface KeyGeneration {
  readonly id: string;
  readonly material: Buffer;
}

interface SecretRow {
  version_id: string;
  secret_id: string;
  purpose: "provider_api_key";
  key_id: string;
  ciphertext: Uint8Array | null;
  nonce: Uint8Array | null;
  authentication_tag: Uint8Array | null;
  state: "active" | "destroyed";
  record_revision: number;
  created_at: string;
  destroyed_at: string | null;
}

interface KeyringRow {
  current_key_id: string;
  record_revision: number;
  updated_at: string;
}

interface EncryptedEnvelope {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly authenticationTag: Buffer;
}

const canonicalizeJson = canonicalizeModule as unknown as (
  input: unknown,
) => string | undefined;

export class SqliteEncryptedSecretStore implements ManagedSecretStore {
  private readonly current: KeyGeneration | null;
  private readonly previous: KeyGeneration | null;

  constructor(
    private readonly db: DatabaseSync,
    environment: Readonly<ManagedSecretKeyEnvironment>,
  ) {
    this.current = parseKeyGeneration(environment.MYAGENT_MASTER_KEY);
    this.previous = parseKeyGeneration(environment.MYAGENT_PREVIOUS_MASTER_KEY);
  }

  createVersion(input: CreateManagedSecretVersionInput): ManagedSecretVersionMetadata {
    const current = this.current;
    if (current === null) throwLocked();
    return this.immediate(() => {
      const keyring = this.keyring();
      if (keyring === undefined) {
        this.db.prepare(
          `INSERT INTO managed_secret_keyring (
             singleton_id, current_key_id, record_revision, updated_at
           ) VALUES (1, ?, 0, ?)`,
        ).run(current.id, input.now.toISOString());
      } else if (keyring.current_key_id !== current.id) {
        throwLocked();
      }

      const envelope = encrypt(current, input);
      this.db.prepare(
        `INSERT INTO managed_secret_versions (
           version_id, secret_id, purpose, key_id, ciphertext, nonce,
           authentication_tag, state, record_revision, created_at, destroyed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, NULL)`,
      ).run(
        input.versionId,
        input.secretId,
        input.purpose,
        current.id,
        envelope.ciphertext,
        envelope.nonce,
        envelope.authenticationTag,
        input.now.toISOString(),
      );
      return this.metadata(this.requiredRow(input.versionId));
    });
  }

  resolve(versionId: ManagedSecretVersionId): string {
    try {
      const keyring = this.keyring();
      if (keyring === undefined || !this.keyringMatchesConfiguredGeneration(keyring)) {
        throwLocked();
      }
      const row = this.requiredActiveRow(versionId);
      const generation = this.authoritativeGeneration(keyring, row);
      const plaintext = decrypt(generation, row);
      try {
        return plaintext.toString("utf8");
      } finally {
        plaintext.fill(0);
      }
    } catch (error) {
      if (isLocked(error)) throw error;
      throwLocked();
    }
  }

  assertActiveVersion(input: AssertManagedSecretVersionInput): void {
    const row = this.row(input.versionId);
    if (row === undefined || row.state !== "active") throwLocked();
    if (
      input.expectedRevision !== undefined &&
      row.record_revision !== input.expectedRevision
    ) {
      throwRevisionConflict();
    }
  }

  destroy(input: DestroyManagedSecretVersionInput): ManagedSecretVersionMetadata {
    return this.immediate(() => {
      this.assertActiveVersion(input);
      const row = this.requiredActiveRow(input.versionId);
      const keyring = this.keyring();
      if (keyring === undefined) throwLocked();
      const generation = this.authoritativeGeneration(keyring, row);
      const plaintext = decrypt(generation, row);
      try {
        const updated = this.db.prepare(
          `UPDATE managed_secret_versions
           SET ciphertext = X'', nonce = X'', authentication_tag = X'',
               state = 'destroyed', record_revision = record_revision + 1,
               destroyed_at = ?
           WHERE version_id = ? AND state = 'active' AND record_revision = ?`,
        ).run(input.now.toISOString(), input.versionId, input.expectedRevision);
        if (updated.changes !== 1) throwRevisionConflict();
        return this.metadata(this.requiredRow(input.versionId));
      } finally {
        plaintext.fill(0);
      }
    });
  }

  rotateMasterKey(input: RotateManagedSecretKeyInput): ManagedSecretRotationResult {
    const current = this.current;
    const previous = this.previous;
    if (current === null || previous === null || current.id === previous.id) {
      throwLocked();
    }

    return this.immediate(() => {
      const keyring = this.keyring();
      if (keyring === undefined || keyring.current_key_id !== previous.id) {
        throwLocked();
      }
      if (keyring.record_revision !== input.expectedRevision) {
        throwRevisionConflict();
      }

      const rows = this.activeRows();
      if (rows.some((row) => row.key_id !== previous.id)) throwLocked();

      const decrypted: Array<{ row: SecretRow; plaintext: Buffer }> = [];
      try {
        for (const row of rows) {
          decrypted.push({ row, plaintext: decrypt(previous, row) });
        }
        for (const { row, plaintext } of decrypted) {
          const envelope = encrypt(current, {
            versionId: row.version_id as ManagedSecretVersionId,
            secretId: row.secret_id,
            purpose: row.purpose,
            plaintext,
          });
          const updated = this.db.prepare(
            `UPDATE managed_secret_versions
             SET key_id = ?, ciphertext = ?, nonce = ?, authentication_tag = ?,
                 record_revision = record_revision + 1
             WHERE version_id = ? AND state = 'active' AND key_id = ?
               AND record_revision = ?`,
          ).run(
            current.id,
            envelope.ciphertext,
            envelope.nonce,
            envelope.authenticationTag,
            row.version_id,
            previous.id,
            row.record_revision,
          );
          if (updated.changes !== 1) throwRevisionConflict();
        }

        const remaining = this.db.prepare(
          `SELECT COUNT(*) AS count
           FROM managed_secret_versions
           WHERE state = 'active' AND key_id <> ?`,
        ).get(current.id) as unknown as { count: number };
        if (remaining.count !== 0) throwLocked();

        const updatedKeyring = this.db.prepare(
          `UPDATE managed_secret_keyring
           SET current_key_id = ?, record_revision = record_revision + 1,
               updated_at = ?
           WHERE singleton_id = 1 AND current_key_id = ? AND record_revision = ?`,
        ).run(
          current.id,
          input.now.toISOString(),
          previous.id,
          input.expectedRevision,
        );
        if (updatedKeyring.changes !== 1) throwRevisionConflict();
        return {
          reencrypted: rows.length,
          currentKeyId: current.id,
          recordRevision: input.expectedRevision + 1,
        };
      } finally {
        for (const { plaintext } of decrypted) plaintext.fill(0);
      }
    });
  }

  private generation(keyId: string): KeyGeneration | null {
    if (this.current?.id === keyId) return this.current;
    if (this.previous?.id === keyId) return this.previous;
    return null;
  }

  private keyringMatchesConfiguredGeneration(keyring: KeyringRow): boolean {
    return keyring.current_key_id === this.current?.id ||
      keyring.current_key_id === this.previous?.id;
  }

  private authoritativeGeneration(
    keyring: KeyringRow,
    row: SecretRow,
  ): KeyGeneration {
    if (row.key_id !== keyring.current_key_id) throwLocked();
    const generation = this.generation(keyring.current_key_id);
    if (generation === null) throwLocked();
    return generation;
  }

  private keyring(): KeyringRow | undefined {
    return this.db.prepare(
      `SELECT current_key_id, record_revision, updated_at
       FROM managed_secret_keyring WHERE singleton_id = 1`,
    ).get() as unknown as KeyringRow | undefined;
  }

  private row(versionId: ManagedSecretVersionId): SecretRow | undefined {
    return this.db.prepare(
      `SELECT version_id, secret_id, purpose, key_id, ciphertext, nonce,
              authentication_tag, state, record_revision, created_at, destroyed_at
       FROM managed_secret_versions WHERE version_id = ?`,
    ).get(versionId) as unknown as SecretRow | undefined;
  }

  private requiredRow(versionId: ManagedSecretVersionId): SecretRow {
    const row = this.row(versionId);
    if (row === undefined) throwLocked();
    return row;
  }

  private requiredActiveRow(versionId: ManagedSecretVersionId): SecretRow {
    const row = this.requiredRow(versionId);
    if (row.state !== "active") throwLocked();
    return row;
  }

  private activeRows(): SecretRow[] {
    return this.db.prepare(
      `SELECT version_id, secret_id, purpose, key_id, ciphertext, nonce,
              authentication_tag, state, record_revision, created_at, destroyed_at
       FROM managed_secret_versions WHERE state = 'active' ORDER BY version_id`,
    ).all() as unknown as SecretRow[];
  }

  private metadata(row: SecretRow): ManagedSecretVersionMetadata {
    return {
      versionId: row.version_id as ManagedSecretVersionId,
      secretId: row.secret_id,
      purpose: row.purpose,
      keyId: row.key_id,
      state: row.state,
      recordRevision: row.record_revision,
      createdAt: new Date(row.created_at),
      destroyedAt: row.destroyed_at === null ? null : new Date(row.destroyed_at),
    };
  }

  private immediate<T>(operation: () => T): T {
    return withImmediateTransaction(this.db, operation);
  }
}

function parseKeyGeneration(encoded: string | undefined): KeyGeneration | null {
  if (encoded === undefined || encoded.length === 0) return null;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) return null;
  const material = Buffer.from(encoded, "base64");
  if (material.length !== 32 || material.toString("base64") !== encoded) return null;
  const fingerprint = createHash("sha256").update(material).digest("base64url");
  return { id: `mk_${fingerprint}`, material };
}

function encrypt(
  generation: KeyGeneration,
  identity: {
    readonly versionId: ManagedSecretVersionId;
    readonly secretId: string;
    readonly purpose: "provider_api_key";
    readonly plaintext: string | Uint8Array;
  },
): EncryptedEnvelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", generation.material, nonce);
  cipher.setAAD(aad(identity));
  const ciphertext = Buffer.concat([
    cipher.update(identity.plaintext),
    cipher.final(),
  ]);
  return {
    ciphertext,
    nonce,
    authenticationTag: cipher.getAuthTag(),
  };
}

function decrypt(generation: KeyGeneration, row: SecretRow): Buffer {
  if (
    row.ciphertext === null || row.nonce === null || row.authentication_tag === null ||
    row.nonce.byteLength !== 12 || row.authentication_tag.byteLength !== 16
  ) {
    throwLocked();
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      generation.material,
      row.nonce,
    );
    decipher.setAAD(aad({
      versionId: row.version_id as ManagedSecretVersionId,
      secretId: row.secret_id,
      purpose: row.purpose,
    }));
    decipher.setAuthTag(row.authentication_tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
  } catch {
    throwLocked();
  }
}

function aad(identity: {
  readonly versionId: ManagedSecretVersionId;
  readonly secretId: string;
  readonly purpose: "provider_api_key";
}): Buffer {
  const canonical = canonicalizeJson({
    secretId: identity.secretId,
    versionId: identity.versionId,
    purpose: identity.purpose,
  });
  if (canonical === undefined) throwLocked();
  return Buffer.from(canonical, "utf8");
}

function isLocked(error: unknown): error is DomainError {
  return error instanceof DomainError && error.code === "secret_locked";
}

function throwLocked(): never {
  throw new DomainError("secret_locked");
}

function throwRevisionConflict(): never {
  throw new ApplicationError("revision_conflict", 409);
}
