import canonicalizeModule from "canonicalize";
import type { DatabaseSync } from "node:sqlite";

import { ApplicationError, DomainError } from "../../domain/errors.js";
import type {
  AgentId,
  ManagedSecretVersionId,
  ModelProfileId,
  ModelProfileRevisionId,
  ModelVerificationId,
  ProviderConnectionId,
  ProviderConnectionRevisionId,
} from "../../domain/ids.js";
import type { SecretReferenceOwner } from "../../domain/managed-secret.js";
import type {
  DefaultModelProfile,
  ModelAssignment,
} from "../../domain/model-assignment.js";
import type {
  ModelProfileRevision,
  ModelProfileView,
} from "../../domain/model-profile.js";
import type { DiscoveryView } from "../../domain/model-registry.js";
import type { ModelVerification } from "../../domain/model-verification.js";
import type {
  ProviderAuth,
  ProviderConnectionRevision,
  ProviderConnectionView,
} from "../../domain/provider-connection.js";
import type {
  CoreModelRegistryStore,
  BeginVerificationAttemptInput,
  CancelVerificationInput,
  ClaimVerificationInput,
  CompleteVerificationInput,
  CreateConnectionRecord,
  CreateConnectionRevisionRecord,
  CreateProfileRecord,
  CreateProfileRevisionRecord,
  MutationContext,
  PromoteConnectionInput,
  PromoteProfileInput,
  PurgeConnectionInput,
  PurgeProfileInput,
  QueueVerificationRecord,
  RecordDiscoveryInput,
  RecordProviderHealthInput,
  RenewVerificationLeaseInput,
  RetireConnectionInput,
  RetireProfileInput,
  SetDefaultProfileInput,
  SetModelAssignmentInput,
  SynchronizeAgentsInput,
} from "../../ports/model-registry-store.js";

interface ConnectionRow {
  connection_id: string;
  display_name: string;
  provider_kind: ProviderConnectionView["providerKind"];
  active_revision_id: string | null;
  retired_at: string | null;
  record_revision: number;
}

interface ConnectionRevisionRow {
  revision_id: string;
  connection_id: string;
  state: ProviderConnectionRevision["state"];
  base_url: string;
  auth_json: string;
  allow_insecure_http: number;
  protocol_preference: ProviderConnectionRevision["protocolPreference"];
  preset_version: string;
  created_at: string;
}

interface ProfileRow {
  profile_id: string;
  display_name: string;
  active_revision_id: string | null;
  retired_at: string | null;
  record_revision: number;
}

interface ProfileRevisionRow {
  revision_id: string;
  profile_id: string;
  connection_revision_id: string;
  state: ModelProfileRevision["state"];
  provider_model_id: string;
  invocation_protocol: ModelProfileRevision["invocationProtocol"];
  max_input_tokens: number;
  context_window_source: ModelProfileRevision["contextWindowSource"];
  capability_baseline: ModelProfileRevision["capabilityBaseline"];
  verified_capabilities_json: string;
  created_at: string;
}

interface AssignmentRow {
  agent_id: string;
  model_profile_revision_id: string;
  source: ModelAssignment["source"];
  record_revision: number;
  updated_at: string;
}

interface DefaultRow {
  profile_id: string;
  record_revision: number;
}

interface RevisionValueRow {
  revision_id: string;
}

interface VerificationEvidenceRow {
  capabilities_json: string;
}

interface DiscoveryGenerationRow {
  generation_id: string;
  connection_revision_id: string;
  state: DiscoveryView["state"];
  fetched_at: string | null;
  expires_at: string | null;
  error_code: string | null;
  safe_status: number | null;
  trace_id: string;
}

interface DiscoveredModelRow {
  model_id: string;
  owner: string | null;
  model_created_at: string | null;
}

interface VerificationRow {
  verification_id: string;
  profile_revision_id: string;
  capability_baseline: ModelVerification["capabilityBaseline"];
  state: ModelVerification["state"];
  attempt_count: number;
  capabilities_json: string;
  result_code: string | null;
  safe_status: number | null;
  usage_json: string | null;
  trace_id: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  cancellation_requested_at: string | null;
  fallback_verification_id: string | null;
  record_revision: number;
  created_at: string;
  updated_at: string;
}

interface VerificationTargetRow {
  profile_revision_id: string;
  profile_id: string;
  connection_revision_id: string;
}

const canonicalizeJson = canonicalizeModule as unknown as (
  input: unknown,
) => string | undefined;

export class SqliteModelRegistryRepository implements CoreModelRegistryStore {
  constructor(private readonly db: DatabaseSync) {}

  createConnection(input: CreateConnectionRecord): ProviderConnectionView {
    assertConnectionRevisionOwner(input.connectionId, input.revision);
    return this.immediate(() => {
      const now = input.now.toISOString();
      this.db.prepare(
        `INSERT INTO provider_connections (
           connection_id, display_name, provider_kind, active_revision_id,
           retired_at, record_revision, created_at, updated_at
         ) VALUES (?, ?, ?, NULL, NULL, 0, ?, ?)`,
      ).run(input.connectionId, input.displayName, input.providerKind, now, now);
      this.insertConnectionRevision(input.revision);
      this.appendAudit(input, "provider_connection", input.connectionId, "connection.created", {
        previousRecordRevision: null,
        newRecordRevision: 0,
      });
      return this.getConnection(input.connectionId);
    });
  }

  createConnectionRevision(
    input: CreateConnectionRevisionRecord,
  ): ProviderConnectionView {
    return this.immediate(() => {
      this.assertMutableStableRevision(
        "provider_connections",
        "connection_id",
        input.connectionId,
        input.expectedRevision,
      );
      assertConnectionRevisionOwner(input.connectionId, input.revision);
      const now = input.now.toISOString();
      const displayName = input.displayName;
      const updated = displayName === undefined
        ? this.db.prepare(
            `UPDATE provider_connections
             SET record_revision = record_revision + 1, updated_at = ?
             WHERE connection_id = ? AND record_revision = ? AND retired_at IS NULL`,
          ).run(now, input.connectionId, input.expectedRevision)
        : this.db.prepare(
            `UPDATE provider_connections
             SET display_name = ?, record_revision = record_revision + 1, updated_at = ?
             WHERE connection_id = ? AND record_revision = ? AND retired_at IS NULL`,
          ).run(displayName, now, input.connectionId, input.expectedRevision);
      if (updated.changes !== 1) {
        this.throwMutationFailure(
          "provider_connections",
          "connection_id",
          input.connectionId,
          input.expectedRevision,
        );
      }
      this.insertConnectionRevision(input.revision);
      this.appendAudit(
        input,
        "provider_connection",
        input.connectionId,
        "connection.revision_created",
        {
          revisionId: input.revision.revisionId,
          previousRecordRevision: input.expectedRevision,
          newRecordRevision: input.expectedRevision + 1,
        },
      );
      return this.getConnection(input.connectionId);
    });
  }

  getConnection(id: ProviderConnectionId): ProviderConnectionView {
    const row = this.db.prepare(
      `SELECT connection_id, display_name, provider_kind, active_revision_id,
              retired_at, record_revision
       FROM provider_connections WHERE connection_id = ?`,
    ).get(id) as unknown as ConnectionRow | undefined;
    if (row === undefined) throw new Error("provider_connection_not_found");
    const revisions = this.db.prepare(
      `SELECT revision_id, connection_id, state, base_url, auth_json,
              allow_insecure_http, protocol_preference, preset_version, created_at
       FROM provider_connection_revisions
       WHERE connection_id = ? ORDER BY created_at, revision_id`,
    ).all(id) as unknown as ConnectionRevisionRow[];
    return {
      connectionId: row.connection_id as ProviderConnectionId,
      displayName: row.display_name,
      providerKind: row.provider_kind,
      activeRevisionId: row.active_revision_id as ProviderConnectionRevisionId | null,
      retiredAt: parseNullableDate(row.retired_at),
      recordRevision: row.record_revision,
      revisions: revisions.map(mapConnectionRevision),
    };
  }

  getConnectionRevision(
    id: ProviderConnectionRevisionId,
  ): {
    providerKind: ProviderConnectionView["providerKind"];
    revision: ProviderConnectionRevision;
  } | null {
    const row = this.db.prepare(
      `SELECT revision.revision_id, revision.connection_id, revision.state,
              revision.base_url, revision.auth_json,
              revision.allow_insecure_http, revision.protocol_preference,
              revision.preset_version, revision.created_at,
              connection.provider_kind
       FROM provider_connection_revisions AS revision
       JOIN provider_connections AS connection
         ON connection.connection_id = revision.connection_id
       WHERE revision.revision_id = ?`,
    ).get(id) as (ConnectionRevisionRow & {
      provider_kind: ProviderConnectionView["providerKind"];
    }) | undefined;
    return row === undefined
      ? null
      : { providerKind: row.provider_kind, revision: mapConnectionRevision(row) };
  }

  listConnections(): readonly ProviderConnectionView[] {
    const rows = this.db.prepare(
      "SELECT connection_id FROM provider_connections ORDER BY connection_id",
    ).all() as unknown as Array<{ connection_id: string }>;
    return rows.map(({ connection_id }) =>
      this.getConnection(connection_id as ProviderConnectionId));
  }

  recordDiscovery(input: RecordDiscoveryInput): DiscoveryView {
    return this.immediate(() => {
      const target = this.connectionRevisionTarget(input.connectionRevisionId);
      this.assertMutableStableRevision(
        "provider_connections",
        "connection_id",
        target.connection_id,
        input.expectedRevision,
      );
      const now = input.now.toISOString();
      this.db.prepare(
        `INSERT INTO discovery_generations (
           generation_id, connection_revision_id, state, fetched_at, expires_at,
           error_code, safe_status, trace_id, record_revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(
        input.generationId,
        input.connectionRevisionId,
        input.state,
        now,
        input.expiresAt?.toISOString() ?? null,
        input.error?.code ?? null,
        input.error?.status ?? null,
        input.traceId,
        now,
        now,
      );
      if (input.state === "fresh" || input.state === "empty") {
        const insertModel = this.db.prepare(
          `INSERT INTO discovered_models (
             generation_id, model_id, owner, model_created_at, ordinal
           ) VALUES (?, ?, ?, ?, ?)`,
        );
        input.models.forEach((model, ordinal) => {
          insertModel.run(
            input.generationId,
            model.id,
            model.owner ?? null,
            model.createdAt?.toISOString() ?? null,
            ordinal,
          );
        });
        this.db.prepare(
          `UPDATE provider_connection_revisions
           SET state = CASE
             WHEN state IN ('active', 'legacy_trusted') THEN state
             ELSE 'verified'
           END
           WHERE revision_id = ?`,
        ).run(input.connectionRevisionId);
      }
      const updated = this.db.prepare(
        `UPDATE provider_connections
         SET record_revision = record_revision + 1, updated_at = ?
         WHERE connection_id = ? AND record_revision = ? AND retired_at IS NULL`,
      ).run(now, target.connection_id, input.expectedRevision);
      if (updated.changes !== 1) throwRevisionConflict();
      this.appendAudit(
        input,
        "provider_connection",
        target.connection_id,
        "connection.discovery_recorded",
        {
          connectionRevisionId: input.connectionRevisionId,
          discoveryState: input.state,
          generationId: input.generationId,
          previousRecordRevision: input.expectedRevision,
          newRecordRevision: input.expectedRevision + 1,
        },
      );
      return this.getDiscoveredModels(input.connectionRevisionId, input.now);
    });
  }

  getDiscoveredModels(
    revisionId: ProviderConnectionRevisionId,
    now: Date,
  ): DiscoveryView {
    const latest = this.db.prepare(
      `SELECT generation_id, connection_revision_id, state, fetched_at, expires_at,
              error_code, safe_status, trace_id
       FROM discovery_generations
       WHERE connection_revision_id = ?
       ORDER BY rowid DESC
       LIMIT 1`,
    ).get(revisionId) as unknown as DiscoveryGenerationRow | undefined;
    if (latest === undefined) {
      return {
        connectionRevisionId: revisionId,
        state: "unsupported",
        models: [],
        fetchedAt: null,
        expiresAt: null,
      };
    }
    if (latest.state === "failed") {
      const cached = this.latestSuccessfulDiscovery(revisionId);
      if (cached !== undefined) {
        return this.discoveryView(cached, "stale", latest);
      }
      return this.discoveryView(latest, "failed", latest);
    }
    if (latest.state === "fresh" || latest.state === "empty") {
      const expired = latest.expires_at !== null && latest.expires_at <= now.toISOString();
      return this.discoveryView(latest, expired ? "stale" : latest.state);
    }
    return this.discoveryView(latest, latest.state);
  }

  createProfile(input: CreateProfileRecord): ModelProfileView {
    assertProfileRevisionOwner(input.profileId, input.revision);
    return this.immediate(() => {
      const now = input.now.toISOString();
      this.db.prepare(
        `INSERT INTO model_profiles (
           profile_id, display_name, active_revision_id, retired_at,
           record_revision, created_at, updated_at
         ) VALUES (?, ?, NULL, NULL, 0, ?, ?)`,
      ).run(input.profileId, input.displayName, now, now);
      this.insertProfileRevision(input.revision);
      this.appendAudit(input, "model_profile", input.profileId, "profile.created", {
        previousRecordRevision: null,
        newRecordRevision: 0,
      });
      return this.getProfile(input.profileId);
    });
  }

  createProfileRevision(input: CreateProfileRevisionRecord): ModelProfileView {
    return this.immediate(() => {
      this.assertMutableStableRevision(
        "model_profiles",
        "profile_id",
        input.profileId,
        input.expectedRevision,
      );
      assertProfileRevisionOwner(input.profileId, input.revision);
      const now = input.now.toISOString();
      const displayName = input.displayName;
      const updated = displayName === undefined
        ? this.db.prepare(
            `UPDATE model_profiles
             SET record_revision = record_revision + 1, updated_at = ?
             WHERE profile_id = ? AND record_revision = ? AND retired_at IS NULL`,
          ).run(now, input.profileId, input.expectedRevision)
        : this.db.prepare(
            `UPDATE model_profiles
             SET display_name = ?, record_revision = record_revision + 1, updated_at = ?
             WHERE profile_id = ? AND record_revision = ? AND retired_at IS NULL`,
          ).run(displayName, now, input.profileId, input.expectedRevision);
      if (updated.changes !== 1) throwRevisionConflict();
      this.insertProfileRevision(input.revision);
      this.appendAudit(
        input,
        "model_profile",
        input.profileId,
        "profile.revision_created",
        {
          revisionId: input.revision.revisionId,
          previousRecordRevision: input.expectedRevision,
          newRecordRevision: input.expectedRevision + 1,
        },
      );
      return this.getProfile(input.profileId);
    });
  }

  getProfile(id: ModelProfileId): ModelProfileView {
    const row = this.db.prepare(
      `SELECT profile_id, display_name, active_revision_id, retired_at,
              record_revision
       FROM model_profiles WHERE profile_id = ?`,
    ).get(id) as unknown as ProfileRow | undefined;
    if (row === undefined) throw new Error("model_profile_not_found");
    const revisions = this.db.prepare(
      `SELECT revision_id, profile_id, connection_revision_id, state,
              provider_model_id, invocation_protocol, max_input_tokens,
              context_window_source, capability_baseline,
              verified_capabilities_json, created_at
       FROM model_profile_revisions
       WHERE profile_id = ? ORDER BY created_at, revision_id`,
    ).all(id) as unknown as ProfileRevisionRow[];
    return {
      profileId: row.profile_id as ModelProfileId,
      displayName: row.display_name,
      activeRevisionId: row.active_revision_id as ModelProfileRevisionId | null,
      retiredAt: parseNullableDate(row.retired_at),
      recordRevision: row.record_revision,
      revisions: revisions.map(mapProfileRevision),
    };
  }

  listProfiles(): readonly ModelProfileView[] {
    const rows = this.db.prepare(
      "SELECT profile_id FROM model_profiles ORDER BY profile_id",
    ).all() as unknown as Array<{ profile_id: string }>;
    return rows.map(({ profile_id }) => this.getProfile(profile_id as ModelProfileId));
  }

  queueVerification(input: QueueVerificationRecord): ModelVerification {
    return this.immediate(() => this.queueVerificationInTransaction(input));
  }

  claimVerification(input: ClaimVerificationInput): ModelVerification | null {
    if (input.leaseUntil <= input.now) throw new DomainError("invalid_verification_lease");
    return this.immediate(() => {
      const row = this.db.prepare(
        `SELECT verification_id
         FROM model_verifications
         WHERE state = 'queued'
            OR (state = 'running' AND lease_expires_at <= ?)
         ORDER BY created_at, verification_id
         LIMIT 1`,
      ).get(input.now.toISOString()) as unknown as {
        verification_id: string;
      } | undefined;
      if (row === undefined) return null;
      const updated = this.db.prepare(
        `UPDATE model_verifications
         SET state = 'running', lease_owner = ?, lease_expires_at = ?,
             record_revision = record_revision + 1, updated_at = ?
         WHERE verification_id = ?
           AND (state = 'queued' OR (state = 'running' AND lease_expires_at <= ?))`,
      ).run(
        input.leaseOwner,
        input.leaseUntil.toISOString(),
        input.now.toISOString(),
        row.verification_id,
        input.now.toISOString(),
      );
      if (updated.changes !== 1) return null;
      return this.getVerification(row.verification_id as ModelVerificationId);
    });
  }

  beginVerificationAttempt(input: BeginVerificationAttemptInput): ModelVerification {
    const updated = this.db.prepare(
      `UPDATE model_verifications
       SET attempt_count = attempt_count + 1,
           record_revision = record_revision + 1, updated_at = ?
       WHERE verification_id = ? AND state = 'running'
         AND lease_owner = ? AND lease_expires_at > ?`,
    ).run(
      input.now.toISOString(),
      input.verificationId,
      input.leaseOwner,
      input.now.toISOString(),
    );
    if (updated.changes !== 1) throw new DomainError("verification_lease_lost");
    return this.getVerification(input.verificationId);
  }

  renewVerificationLease(input: RenewVerificationLeaseInput): boolean {
    if (input.leaseUntil <= input.now) return false;
    const updated = this.db.prepare(
      `UPDATE model_verifications
       SET lease_expires_at = ?, record_revision = record_revision + 1, updated_at = ?
       WHERE verification_id = ? AND state = 'running'
         AND lease_owner = ? AND lease_expires_at > ?`,
    ).run(
      input.leaseUntil.toISOString(),
      input.now.toISOString(),
      input.verificationId,
      input.leaseOwner,
      input.now.toISOString(),
    );
    return updated.changes === 1;
  }

  completeVerification(input: CompleteVerificationInput): ModelVerification {
    return this.immediate(() => {
      const target = this.verificationTarget(input.verificationId);
      if (input.fallback !== undefined) {
        this.assertMutableStableRevision(
          "model_profiles",
          "profile_id",
          target.profile_id,
          input.fallback.verification.expectedRevision,
        );
        assertProfileRevisionOwner(
          target.profile_id as ModelProfileId,
          input.fallback.revision,
        );
        if (
          input.fallback.verification.profileRevisionId !==
          input.fallback.revision.revisionId
        ) {
          throw new DomainError("verification_profile_revision_mismatch");
        }
      }
      const updated = this.db.prepare(
        `UPDATE model_verifications
         SET state = ?, capabilities_json = ?, result_code = ?, safe_status = ?,
             usage_json = ?, trace_id = ?, lease_owner = NULL,
             lease_expires_at = NULL, fallback_verification_id = NULL,
             record_revision = record_revision + 1, updated_at = ?
         WHERE verification_id = ? AND state = 'running'
           AND lease_owner = ? AND lease_expires_at > ?`,
      ).run(
        input.outcome,
        serialize(input.capabilities),
        input.resultCode ?? null,
        input.safeStatus ?? null,
        input.usage === undefined ? null : serialize(input.usage),
        input.traceId,
        input.now.toISOString(),
        input.verificationId,
        input.leaseOwner,
        input.now.toISOString(),
      );
      if (updated.changes !== 1) throw new DomainError("verification_lease_lost");

      if (input.outcome === "passed") {
        this.db.prepare(
          `UPDATE model_profile_revisions
           SET state = 'verified', verified_capabilities_json = ?
           WHERE revision_id = ?`,
        ).run(serialize(input.capabilities), target.profile_revision_id);
        this.db.prepare(
          `UPDATE provider_connection_revisions
           SET state = CASE
             WHEN state IN ('active', 'legacy_trusted') THEN state
             ELSE 'verified'
           END
           WHERE revision_id = ?`,
        ).run(target.connection_revision_id);
      } else {
        this.db.prepare(
          "UPDATE model_profile_revisions SET state = 'failed' WHERE revision_id = ?",
        ).run(target.profile_revision_id);
      }

      this.recordProviderHealthInTransaction({
        connectionRevisionId:
          target.connection_revision_id as ProviderConnectionRevisionId,
        profileRevisionId: target.profile_revision_id as ModelProfileRevisionId,
        outcome: input.outcome === "passed" ? "success" : "failure",
        ...(input.resultCode === undefined ? {} : { code: input.resultCode }),
        ...(input.safeStatus === undefined ? {} : { safeStatus: input.safeStatus }),
        traceId: input.traceId,
        observedAt: input.now,
      });

      if (input.fallback !== undefined) {
        this.insertProfileRevision(input.fallback.revision);
        this.queueVerificationInTransaction(input.fallback.verification);
        this.db.prepare(
          `UPDATE model_verifications
           SET fallback_verification_id = ?
           WHERE verification_id = ?`,
        ).run(
          input.fallback.verification.verificationId,
          input.verificationId,
        );
      }
      this.appendAudit(
        input,
        "model_verification",
        input.verificationId,
        "verification.completed",
        {
          fallbackVerificationId: input.fallback?.verification.verificationId ?? null,
          outcome: input.outcome,
        },
      );
      return this.getVerification(input.verificationId);
    });
  }

  cancelVerification(input: CancelVerificationInput): ModelVerification {
    return this.immediate(() => {
      const existing = this.verificationRow(input.verificationId);
      if (existing.record_revision !== input.expectedRevision) throwRevisionConflict();
      if (existing.state === "cancelled") return mapVerification(existing);
      if (existing.state === "passed" || existing.state === "failed") {
        throw new DomainError("verification_terminal");
      }
      const updated = this.db.prepare(
        `UPDATE model_verifications
         SET state = 'cancelled', cancellation_requested_at = ?,
             lease_owner = NULL, lease_expires_at = NULL, trace_id = ?,
             record_revision = record_revision + 1, updated_at = ?
         WHERE verification_id = ? AND record_revision = ?
           AND state IN ('queued', 'running')`,
      ).run(
        input.now.toISOString(),
        input.traceId,
        input.now.toISOString(),
        input.verificationId,
        input.expectedRevision,
      );
      if (updated.changes !== 1) throwRevisionConflict();
      this.appendAudit(
        input,
        "model_verification",
        input.verificationId,
        "verification.cancelled",
        {
          previousRecordRevision: input.expectedRevision,
          newRecordRevision: input.expectedRevision + 1,
        },
      );
      return this.getVerification(input.verificationId);
    });
  }

  getVerification(id: ModelVerificationId): ModelVerification {
    return mapVerification(this.verificationRow(id));
  }

  recordProviderHealth(input: RecordProviderHealthInput): void {
    this.recordProviderHealthInTransaction(input);
  }

  promoteConnection(input: PromoteConnectionInput): ProviderConnectionView {
    return this.immediate(() => {
      this.assertMutableStableRevision(
        "provider_connections",
        "connection_id",
        input.connectionId,
        input.expectedRevision,
      );
      this.assertConnectionPromotionEvidence(input.connectionId, input.revisionId);
      const now = input.now.toISOString();
      const updated = this.db.prepare(
        `UPDATE provider_connections
         SET active_revision_id = ?, record_revision = record_revision + 1,
             updated_at = ?
         WHERE connection_id = ? AND record_revision = ? AND retired_at IS NULL`,
      ).run(
        input.revisionId,
        now,
        input.connectionId,
        input.expectedRevision,
      );
      if (updated.changes !== 1) {
        this.throwMutationFailure(
          "provider_connections",
          "connection_id",
          input.connectionId,
          input.expectedRevision,
        );
      }
      this.db.prepare(
        `UPDATE provider_connection_revisions
         SET state = 'superseded'
         WHERE connection_id = ? AND state = 'active' AND revision_id <> ?`,
      ).run(input.connectionId, input.revisionId);
      this.db.prepare(
        `UPDATE provider_connection_revisions SET state = 'active'
         WHERE revision_id = ? AND connection_id = ?`,
      ).run(input.revisionId, input.connectionId);
      this.appendAudit(
        input,
        "provider_connection",
        input.connectionId,
        "connection.promoted",
        {
          revisionId: input.revisionId,
          previousRecordRevision: input.expectedRevision,
          newRecordRevision: input.expectedRevision + 1,
        },
      );
      return this.getConnection(input.connectionId);
    });
  }

  promoteProfile(input: PromoteProfileInput): ModelProfileView {
    return this.immediate(() => {
      this.assertMutableStableRevision(
        "model_profiles",
        "profile_id",
        input.profileId,
        input.expectedRevision,
      );
      const evidence = this.profilePromotionEvidence(input.profileId, input.revisionId);
      const now = input.now.toISOString();
      const updated = this.db.prepare(
        `UPDATE model_profiles
         SET active_revision_id = ?, record_revision = record_revision + 1,
             updated_at = ?
         WHERE profile_id = ? AND record_revision = ? AND retired_at IS NULL`,
      ).run(input.revisionId, now, input.profileId, input.expectedRevision);
      if (updated.changes !== 1) {
        this.throwMutationFailure(
          "model_profiles",
          "profile_id",
          input.profileId,
          input.expectedRevision,
        );
      }
      this.db.prepare(
        `UPDATE model_profile_revisions
         SET state = 'superseded'
         WHERE profile_id = ? AND state = 'active' AND revision_id <> ?`,
      ).run(input.profileId, input.revisionId);
      this.db.prepare(
        `UPDATE model_profile_revisions
         SET state = 'active', verified_capabilities_json = ?
         WHERE revision_id = ? AND profile_id = ?`,
      ).run(evidence.capabilities_json, input.revisionId, input.profileId);
      this.appendAudit(input, "model_profile", input.profileId, "profile.promoted", {
        revisionId: input.revisionId,
        previousRecordRevision: input.expectedRevision,
        newRecordRevision: input.expectedRevision + 1,
      });
      return this.getProfile(input.profileId);
    });
  }

  setDefaultProfile(input: SetDefaultProfileInput): DefaultModelProfile {
    return this.immediate(() => {
      const existing = this.defaultRow();
      if (existing === undefined) {
        if (input.expectedRevision !== 0) throwRevisionConflict();
      } else if (existing.record_revision !== input.expectedRevision) {
        throwRevisionConflict();
      }
      this.assertProfileDefaultEligible(input.profileId);
      let newRevision: number;
      if (existing === undefined) {
        this.db.prepare(
          `INSERT INTO default_model_profile (
             singleton_id, profile_id, record_revision, updated_at
           ) VALUES (1, ?, 0, ?)`,
        ).run(input.profileId, input.now.toISOString());
        newRevision = 0;
      } else {
        const updated = this.db.prepare(
          `UPDATE default_model_profile
           SET profile_id = ?, record_revision = record_revision + 1, updated_at = ?
           WHERE singleton_id = 1 AND record_revision = ?`,
        ).run(input.profileId, input.now.toISOString(), input.expectedRevision);
        if (updated.changes !== 1) throwRevisionConflict();
        newRevision = input.expectedRevision + 1;
      }
      this.appendAudit(input, "default_model_profile", "default", "default.updated", {
        profileId: input.profileId,
        previousRecordRevision: existing?.record_revision ?? null,
        newRecordRevision: newRevision,
      });
      return { profileId: input.profileId, recordRevision: newRevision };
    });
  }

  getDefaultProfile(): DefaultModelProfile | null {
    const row = this.defaultRow();
    return row === undefined
      ? null
      : {
          profileId: row.profile_id as ModelProfileId,
          recordRevision: row.record_revision,
        };
  }

  setAssignment(input: SetModelAssignmentInput): ModelAssignment {
    return this.immediate(() => {
      const existing = this.assignmentRow(input.agentId);
      if (existing === undefined) {
        if (input.expectedRevision !== 0) throwRevisionConflict();
      } else if (existing.record_revision !== input.expectedRevision) {
        throwRevisionConflict();
      }
      this.assertAssignmentEligible(input.profileRevisionId);
      let newRevision: number;
      if (existing === undefined) {
        this.db.prepare(
          `INSERT INTO model_assignments (
             agent_id, model_profile_revision_id, source,
             record_revision, updated_at
           ) VALUES (?, ?, ?, 0, ?)`,
        ).run(
          input.agentId,
          input.profileRevisionId,
          input.source,
          input.now.toISOString(),
        );
        newRevision = 0;
      } else {
        const updated = this.db.prepare(
          `UPDATE model_assignments
           SET model_profile_revision_id = ?, source = ?,
               record_revision = record_revision + 1, updated_at = ?
           WHERE agent_id = ? AND record_revision = ?`,
        ).run(
          input.profileRevisionId,
          input.source,
          input.now.toISOString(),
          input.agentId,
          input.expectedRevision,
        );
        if (updated.changes !== 1) throwRevisionConflict();
        newRevision = input.expectedRevision + 1;
      }
      this.appendAudit(input, "model_assignment", input.agentId, "assignment.updated", {
        profileRevisionId: input.profileRevisionId,
        previousRecordRevision: existing?.record_revision ?? null,
        newRecordRevision: newRevision,
      });
      return this.getRequiredAssignment(input.agentId);
    });
  }

  getAssignment(agentId: AgentId): ModelAssignment | null {
    const row = this.assignmentRow(agentId);
    return row === undefined ? null : mapAssignment(row);
  }

  synchronizeAgents(input: SynchronizeAgentsInput): readonly ModelAssignment[] {
    return this.immediate(() => {
      const defaultProfile = this.getDefaultProfile();
      if (defaultProfile === null) throw new DomainError("model_assignment_required");
      const profile = this.getProfile(defaultProfile.profileId);
      if (profile.activeRevisionId === null) {
        throw new DomainError("model_assignment_required");
      }
      this.assertAssignmentEligible(profile.activeRevisionId);
      const created: ModelAssignment[] = [];
      const seen = new Set<string>();
      for (const agentId of input.agentIds) {
        if (seen.has(agentId)) continue;
        seen.add(agentId);
        const result = this.db.prepare(
          `INSERT INTO model_assignments (
             agent_id, model_profile_revision_id, source,
             record_revision, updated_at
           ) VALUES (?, ?, 'default', 0, ?)
           ON CONFLICT(agent_id) DO NOTHING`,
        ).run(agentId, profile.activeRevisionId, input.now.toISOString());
        if (result.changes === 1) created.push(this.getRequiredAssignment(agentId));
      }
      this.appendAudit(input, "model_assignment", "synchronize", "assignment.synchronized", {
        resourceIds: created.map(({ agentId }) => agentId),
        previousRecordRevision: null,
        newRecordRevision: 0,
      });
      return created;
    });
  }

  retireConnection(input: RetireConnectionInput): ProviderConnectionView {
    return this.immediate(() => {
      const updated = this.db.prepare(
        `UPDATE provider_connections
         SET retired_at = ?, record_revision = record_revision + 1, updated_at = ?
         WHERE connection_id = ? AND record_revision = ? AND retired_at IS NULL`,
      ).run(
        input.now.toISOString(),
        input.now.toISOString(),
        input.connectionId,
        input.expectedRevision,
      );
      if (updated.changes !== 1) {
        this.throwMutationFailure(
          "provider_connections",
          "connection_id",
          input.connectionId,
          input.expectedRevision,
        );
      }
      this.db.prepare(
        `UPDATE provider_connection_revisions SET state = 'retired'
         WHERE connection_id = ? AND state = 'active'`,
      ).run(input.connectionId);
      this.appendAudit(input, "provider_connection", input.connectionId, "connection.retired", {
        previousRecordRevision: input.expectedRevision,
        newRecordRevision: input.expectedRevision + 1,
      });
      return this.getConnection(input.connectionId);
    });
  }

  retireProfile(input: RetireProfileInput): ModelProfileView {
    return this.immediate(() => {
      const updated = this.db.prepare(
        `UPDATE model_profiles
         SET retired_at = ?, record_revision = record_revision + 1, updated_at = ?
         WHERE profile_id = ? AND record_revision = ? AND retired_at IS NULL`,
      ).run(
        input.now.toISOString(),
        input.now.toISOString(),
        input.profileId,
        input.expectedRevision,
      );
      if (updated.changes !== 1) {
        this.throwMutationFailure(
          "model_profiles",
          "profile_id",
          input.profileId,
          input.expectedRevision,
        );
      }
      this.db.prepare(
        `UPDATE model_profile_revisions SET state = 'retired'
         WHERE profile_id = ? AND state = 'active'`,
      ).run(input.profileId);
      this.appendAudit(input, "model_profile", input.profileId, "profile.retired", {
        previousRecordRevision: input.expectedRevision,
        newRecordRevision: input.expectedRevision + 1,
      });
      return this.getProfile(input.profileId);
    });
  }

  purgeConnection(input: PurgeConnectionInput): void {
    this.immediate(() => {
      this.assertExpectedRevision(
        "provider_connections",
        "connection_id",
        input.connectionId,
        input.expectedRevision,
      );
      if (this.connectionReferenceCount(input.connectionId) > 0) {
        throw new DomainError("resource_in_use");
      }
      this.appendAudit(input, "provider_connection", input.connectionId, "connection.purged", {
        previousRecordRevision: input.expectedRevision,
        newRecordRevision: null,
      });
      this.db.prepare(
        "UPDATE provider_connections SET active_revision_id = NULL WHERE connection_id = ?",
      ).run(input.connectionId);
      this.db.prepare(
        "DELETE FROM provider_connections WHERE connection_id = ?",
      ).run(input.connectionId);
    });
  }

  purgeProfile(input: PurgeProfileInput): void {
    this.immediate(() => {
      this.assertExpectedRevision(
        "model_profiles",
        "profile_id",
        input.profileId,
        input.expectedRevision,
      );
      if (this.profileReferenceCount(input.profileId) > 0) {
        throw new DomainError("resource_in_use");
      }
      this.appendAudit(input, "model_profile", input.profileId, "profile.purged", {
        previousRecordRevision: input.expectedRevision,
        newRecordRevision: null,
      });
      this.db.prepare(
        "UPDATE model_profiles SET active_revision_id = NULL WHERE profile_id = ?",
      ).run(input.profileId);
      this.db.prepare("DELETE FROM model_profiles WHERE profile_id = ?")
        .run(input.profileId);
    });
  }

  inspectSecretReferences(
    versionId: ManagedSecretVersionId,
  ): readonly SecretReferenceOwner[] {
    const connectionRows = this.db.prepare(
      `SELECT revision_id
       FROM provider_connection_revisions
       WHERE json_extract(auth_json, '$.secret.managedSecretVersionId') = ?
       ORDER BY revision_id`,
    ).all(versionId) as unknown as RevisionValueRow[];
    const retainedRows = this.db.prepare(
      `SELECT DISTINCT agent_revisions.revision_id
       FROM agent_revisions,
            json_tree(
              CASE WHEN json_valid(agent_revisions.content_json)
                   THEN agent_revisions.content_json ELSE '{}' END
            ) AS item
       WHERE item.key = 'managedSecretVersionId' AND item.value = ?
       ORDER BY agent_revisions.revision_id`,
    ).all(versionId) as unknown as RevisionValueRow[];
    return [
      ...connectionRows.map(({ revision_id }) => ({
        type: "provider_connection_revision" as const,
        id: revision_id as ProviderConnectionRevisionId,
      })),
      ...retainedRows.map(({ revision_id }) => ({
        type: "retained_run_snapshot" as const,
        id: revision_id,
      })),
    ];
  }

  private connectionRevisionTarget(
    revisionId: ProviderConnectionRevisionId,
  ): { connection_id: string } {
    const target = this.db.prepare(
      `SELECT connection_id
       FROM provider_connection_revisions
       WHERE revision_id = ?`,
    ).get(revisionId) as unknown as { connection_id: string } | undefined;
    if (target === undefined) throw new Error("provider_connection_revision_not_found");
    return target;
  }

  private latestSuccessfulDiscovery(
    revisionId: ProviderConnectionRevisionId,
  ): DiscoveryGenerationRow | undefined {
    return this.db.prepare(
      `SELECT generation_id, connection_revision_id, state, fetched_at, expires_at,
              error_code, safe_status, trace_id
       FROM discovery_generations
       WHERE connection_revision_id = ? AND state IN ('fresh', 'empty')
       ORDER BY rowid DESC
       LIMIT 1`,
    ).get(revisionId) as unknown as DiscoveryGenerationRow | undefined;
  }

  private discoveryView(
    generation: DiscoveryGenerationRow,
    state: DiscoveryView["state"],
    refreshError?: DiscoveryGenerationRow,
  ): DiscoveryView {
    const rows = this.db.prepare(
      `SELECT model_id, owner, model_created_at
       FROM discovered_models
       WHERE generation_id = ?
       ORDER BY ordinal, model_id`,
    ).all(generation.generation_id) as unknown as DiscoveredModelRow[];
    const models = rows.map((row) => ({
      id: row.model_id,
      ...(row.owner === null ? {} : { owner: row.owner }),
      ...(row.model_created_at === null
        ? {}
        : { createdAt: new Date(row.model_created_at) }),
    }));
    return {
      connectionRevisionId:
        generation.connection_revision_id as ProviderConnectionRevisionId,
      state,
      models,
      fetchedAt: parseNullableDate(generation.fetched_at),
      expiresAt: parseNullableDate(generation.expires_at),
      ...(refreshError?.error_code === null || refreshError?.error_code === undefined
        ? {}
        : {
            refreshError: {
              code: refreshError.error_code,
              ...(refreshError.safe_status === null
                ? {}
                : { status: refreshError.safe_status }),
              traceId: refreshError.trace_id,
            },
          }),
    };
  }

  private queueVerificationInTransaction(
    input: QueueVerificationRecord,
  ): ModelVerification {
    const target = this.db.prepare(
      `SELECT profile_revision.profile_id
       FROM model_profile_revisions AS profile_revision
       WHERE profile_revision.revision_id = ?`,
    ).get(input.profileRevisionId) as unknown as { profile_id: string } | undefined;
    if (target === undefined) throw new Error("model_profile_revision_not_found");
    this.assertMutableStableRevision(
      "model_profiles",
      "profile_id",
      target.profile_id,
      input.expectedRevision,
    );
    const now = input.now.toISOString();
    const updated = this.db.prepare(
      `UPDATE model_profiles
       SET record_revision = record_revision + 1, updated_at = ?
       WHERE profile_id = ? AND record_revision = ? AND retired_at IS NULL`,
    ).run(now, target.profile_id, input.expectedRevision);
    if (updated.changes !== 1) throwRevisionConflict();
    this.db.prepare(
      `UPDATE model_profile_revisions
       SET state = 'verifying'
       WHERE revision_id = ?`,
    ).run(input.profileRevisionId);
    this.db.prepare(
      `INSERT INTO model_verifications (
         verification_id, profile_revision_id, capability_baseline, state,
         attempt_count, capabilities_json, trace_id, record_revision,
         created_at, updated_at
       ) VALUES (?, ?, ?, 'queued', 0, '[]', ?, 0, ?, ?)`,
    ).run(
      input.verificationId,
      input.profileRevisionId,
      input.capabilityBaseline,
      input.traceId,
      now,
      now,
    );
    this.appendAudit(
      input,
      "model_verification",
      input.verificationId,
      "verification.queued",
      {
        profileRevisionId: input.profileRevisionId,
        previousRecordRevision: input.expectedRevision,
        newRecordRevision: input.expectedRevision + 1,
      },
    );
    return this.getVerification(input.verificationId);
  }

  private verificationRow(id: ModelVerificationId): VerificationRow {
    const row = this.db.prepare(
      `SELECT verification_id, profile_revision_id, capability_baseline, state,
              attempt_count, capabilities_json, result_code, safe_status,
              usage_json, trace_id, lease_owner, lease_expires_at,
              cancellation_requested_at, fallback_verification_id,
              record_revision, created_at, updated_at
       FROM model_verifications
       WHERE verification_id = ?`,
    ).get(id) as unknown as VerificationRow | undefined;
    if (row === undefined) throw new Error("model_verification_not_found");
    return row;
  }

  private verificationTarget(id: ModelVerificationId): VerificationTargetRow {
    const row = this.db.prepare(
      `SELECT verification.profile_revision_id, profile_revision.profile_id,
              profile_revision.connection_revision_id
       FROM model_verifications AS verification
       JOIN model_profile_revisions AS profile_revision
         ON profile_revision.revision_id = verification.profile_revision_id
       WHERE verification.verification_id = ?`,
    ).get(id) as unknown as VerificationTargetRow | undefined;
    if (row === undefined) throw new Error("model_verification_not_found");
    return row;
  }

  private recordProviderHealthInTransaction(input: RecordProviderHealthInput): void {
    if (input.profileRevisionId !== undefined) {
      const exactTarget = this.db.prepare(
        `SELECT 1 AS exact_target
         FROM model_profile_revisions
         WHERE revision_id = ? AND connection_revision_id = ?`,
      ).get(input.profileRevisionId, input.connectionRevisionId);
      if (exactTarget === undefined) {
        throw new DomainError("provider_health_target_mismatch");
      }
    }
    const failureCount = input.outcome === "failure" ? 1 : 0;
    this.db.prepare(
      `INSERT INTO provider_health (
         connection_revision_id, profile_revision_id, outcome,
         consecutive_failures, code, safe_status, trace_id,
         observed_at, record_revision
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT DO UPDATE SET
         outcome = excluded.outcome,
         consecutive_failures = CASE
           WHEN excluded.outcome = 'failure'
             THEN provider_health.consecutive_failures + 1
           ELSE 0
         END,
         code = excluded.code,
         safe_status = excluded.safe_status,
         trace_id = excluded.trace_id,
         observed_at = excluded.observed_at,
         record_revision = provider_health.record_revision + 1`,
    ).run(
      input.connectionRevisionId,
      input.profileRevisionId ?? null,
      input.outcome,
      failureCount,
      input.code ?? null,
      input.safeStatus ?? null,
      input.traceId,
      input.observedAt.toISOString(),
    );
  }

  private insertConnectionRevision(revision: ProviderConnectionRevision): void {
    this.db.prepare(
      `INSERT INTO provider_connection_revisions (
         revision_id, connection_id, state, base_url, auth_json,
         allow_insecure_http, protocol_preference, preset_version, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      revision.revisionId,
      revision.connectionId,
      revision.state,
      revision.baseUrl,
      serialize(revision.auth),
      revision.allowInsecureHttp ? 1 : 0,
      revision.protocolPreference,
      revision.presetVersion,
      revision.createdAt.toISOString(),
    );
  }

  private insertProfileRevision(revision: ModelProfileRevision): void {
    this.db.prepare(
      `INSERT INTO model_profile_revisions (
         revision_id, profile_id, connection_revision_id, state,
         provider_model_id, invocation_protocol, max_input_tokens,
         context_window_source, capability_baseline,
         verified_capabilities_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      revision.revisionId,
      revision.profileId,
      revision.connectionRevisionId,
      revision.state,
      revision.providerModelId,
      revision.invocationProtocol,
      revision.maxInputTokens,
      revision.contextWindowSource,
      revision.capabilityBaseline,
      serialize(revision.verifiedCapabilities),
      revision.createdAt.toISOString(),
    );
  }

  private assertConnectionPromotionEvidence(
    connectionId: ProviderConnectionId,
    revisionId: ProviderConnectionRevisionId,
  ): void {
    const revision = this.db.prepare(
      `SELECT 1 AS present
       FROM provider_connection_revisions
       WHERE revision_id = ? AND connection_id = ? AND state = 'verified'`,
    ).get(revisionId, connectionId);
    if (revision === undefined) throw new DomainError("verification_required");
    const evidence = this.db.prepare(
      `SELECT 1 AS passing
       WHERE EXISTS (
         SELECT 1 FROM discovery_generations
         WHERE connection_revision_id = ? AND state IN ('fresh', 'empty')
       ) OR EXISTS (
         SELECT 1
         FROM model_verifications AS verification
         JOIN model_profile_revisions AS profile_revision
           ON profile_revision.revision_id = verification.profile_revision_id
         WHERE profile_revision.connection_revision_id = ?
           AND verification.state = 'passed'
           AND verification.capability_baseline = 'text_and_single_tool_call_v1'
           AND EXISTS (
             SELECT 1 FROM json_each(verification.capabilities_json)
             WHERE value = 'streaming_text'
           )
           AND EXISTS (
             SELECT 1 FROM json_each(verification.capabilities_json)
             WHERE value = 'single_tool_call'
           )
       )`,
    ).get(revisionId, revisionId);
    if (evidence === undefined) throw new DomainError("verification_required");
  }

  private profilePromotionEvidence(
    profileId: ModelProfileId,
    revisionId: ModelProfileRevisionId,
  ): VerificationEvidenceRow {
    const evidence = this.db.prepare(
      `SELECT verification.capabilities_json
       FROM model_verifications AS verification
       JOIN model_profile_revisions AS profile_revision
         ON profile_revision.revision_id = verification.profile_revision_id
       JOIN provider_connection_revisions AS connection_revision
         ON connection_revision.revision_id = profile_revision.connection_revision_id
       JOIN provider_connections AS connection
         ON connection.connection_id = connection_revision.connection_id
       WHERE profile_revision.revision_id = ?
         AND profile_revision.profile_id = ?
         AND profile_revision.state = 'verified'
         AND verification.state = 'passed'
         AND verification.capability_baseline = profile_revision.capability_baseline
         AND connection_revision.state = 'active'
         AND connection.active_revision_id = connection_revision.revision_id
         AND connection.retired_at IS NULL
         AND EXISTS (
           SELECT 1 FROM json_each(verification.capabilities_json)
           WHERE value = 'streaming_text'
         )
         AND EXISTS (
           SELECT 1 FROM json_each(verification.capabilities_json)
           WHERE value = 'single_tool_call'
         )
       ORDER BY verification.updated_at DESC, verification.verification_id DESC
       LIMIT 1`,
    ).get(revisionId, profileId) as unknown as VerificationEvidenceRow | undefined;
    if (evidence === undefined) throw new DomainError("verification_required");
    return evidence;
  }

  private assertProfileDefaultEligible(profileId: ModelProfileId): void {
    const row = this.db.prepare(
      `SELECT active_revision_id
       FROM model_profiles
       WHERE profile_id = ? AND retired_at IS NULL AND active_revision_id IS NOT NULL`,
    ).get(profileId) as unknown as { active_revision_id: string } | undefined;
    if (row === undefined) throw new DomainError("verification_required");
    this.assertAssignmentEligible(row.active_revision_id as ModelProfileRevisionId);
  }

  private assertAssignmentEligible(revisionId: ModelProfileRevisionId): void {
    const eligible = this.db.prepare(
      `SELECT 1 AS eligible
       FROM model_profile_revisions AS profile_revision
       JOIN model_profiles AS profile
         ON profile.profile_id = profile_revision.profile_id
       JOIN provider_connection_revisions AS connection_revision
         ON connection_revision.revision_id = profile_revision.connection_revision_id
       JOIN provider_connections AS connection
         ON connection.connection_id = connection_revision.connection_id
       WHERE profile_revision.revision_id = ?
         AND profile_revision.state = 'active'
         AND profile.active_revision_id = profile_revision.revision_id
         AND profile.retired_at IS NULL
         AND connection_revision.state = 'active'
         AND connection.active_revision_id = connection_revision.revision_id
         AND connection.retired_at IS NULL
         AND EXISTS (
           SELECT 1 FROM json_each(profile_revision.verified_capabilities_json)
           WHERE value = 'streaming_text'
         )
         AND EXISTS (
           SELECT 1 FROM json_each(profile_revision.verified_capabilities_json)
           WHERE value = 'single_tool_call'
         )`,
    ).get(revisionId);
    if (eligible === undefined) throw new DomainError("verification_required");
  }

  private connectionReferenceCount(connectionId: ProviderConnectionId): number {
    const row = this.db.prepare(
      `SELECT
         (SELECT COUNT(*)
          FROM model_profile_revisions
          WHERE connection_revision_id IN (
            SELECT revision_id FROM provider_connection_revisions
            WHERE connection_id = ?
          ))
         +
         (SELECT COUNT(DISTINCT agent_revisions.revision_id)
          FROM agent_revisions,
               json_tree(
                 CASE WHEN json_valid(agent_revisions.content_json)
                      THEN agent_revisions.content_json ELSE '{}' END
               ) AS item
          WHERE (item.key = 'providerConnectionId' AND item.value = ?)
             OR (
               item.key = 'providerConnectionRevisionId'
               AND item.value IN (
                 SELECT revision_id FROM provider_connection_revisions
                 WHERE connection_id = ?
               )
             )) AS reference_count`,
    ).get(connectionId, connectionId, connectionId) as unknown as {
      reference_count: number;
    };
    return row.reference_count;
  }

  private profileReferenceCount(profileId: ModelProfileId): number {
    const row = this.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM default_model_profile WHERE profile_id = ?)
         +
         (SELECT COUNT(*)
          FROM model_assignments
          WHERE model_profile_revision_id IN (
            SELECT revision_id FROM model_profile_revisions WHERE profile_id = ?
          ))
         +
         (SELECT COUNT(DISTINCT agent_revisions.revision_id)
          FROM agent_revisions,
               json_tree(
                 CASE WHEN json_valid(agent_revisions.content_json)
                      THEN agent_revisions.content_json ELSE '{}' END
               ) AS item
          WHERE (item.key = 'profileId' AND item.value = ?)
             OR (
               item.key = 'modelProfileRevisionId'
               AND item.value IN (
                 SELECT revision_id FROM model_profile_revisions WHERE profile_id = ?
               )
             )) AS reference_count`,
    ).get(profileId, profileId, profileId, profileId) as unknown as {
      reference_count: number;
    };
    return row.reference_count;
  }

  private assignmentRow(agentId: AgentId): AssignmentRow | undefined {
    return this.db.prepare(
      `SELECT agent_id, model_profile_revision_id, source,
              record_revision, updated_at
       FROM model_assignments WHERE agent_id = ?`,
    ).get(agentId) as unknown as AssignmentRow | undefined;
  }

  private getRequiredAssignment(agentId: AgentId): ModelAssignment {
    const assignment = this.getAssignment(agentId);
    if (assignment === null) throw new Error("model_assignment_not_found");
    return assignment;
  }

  private defaultRow(): DefaultRow | undefined {
    return this.db.prepare(
      `SELECT profile_id, record_revision
       FROM default_model_profile WHERE singleton_id = 1`,
    ).get() as unknown as DefaultRow | undefined;
  }

  private assertExpectedRevision(
    table: "provider_connections" | "model_profiles",
    idColumn: "connection_id" | "profile_id",
    id: string,
    expectedRevision: number,
  ): void {
    const row = this.db.prepare(
      `SELECT record_revision FROM ${table} WHERE ${idColumn} = ?`,
    ).get(id) as unknown as { record_revision: number } | undefined;
    if (row === undefined) throw new Error("registry_resource_not_found");
    if (row.record_revision !== expectedRevision) throwRevisionConflict();
  }

  private assertMutableStableRevision(
    table: "provider_connections" | "model_profiles",
    idColumn: "connection_id" | "profile_id",
    id: string,
    expectedRevision: number,
  ): void {
    const row = this.db.prepare(
      `SELECT record_revision, retired_at FROM ${table} WHERE ${idColumn} = ?`,
    ).get(id) as unknown as {
      record_revision: number;
      retired_at: string | null;
    } | undefined;
    if (row === undefined) throw new Error("registry_resource_not_found");
    if (row.record_revision !== expectedRevision) throwRevisionConflict();
    if (row.retired_at !== null) throw new DomainError("resource_retired");
  }

  private throwMutationFailure(
    table: "provider_connections" | "model_profiles",
    idColumn: "connection_id" | "profile_id",
    id: string,
    expectedRevision: number,
  ): never {
    const row = this.db.prepare(
      `SELECT record_revision, retired_at FROM ${table} WHERE ${idColumn} = ?`,
    ).get(id) as unknown as {
      record_revision: number;
      retired_at: string | null;
    } | undefined;
    if (row === undefined) throw new Error("registry_resource_not_found");
    if (row.record_revision !== expectedRevision) throwRevisionConflict();
    if (row.retired_at !== null) throw new DomainError("resource_retired");
    throwRevisionConflict();
  }

  private appendAudit(
    context: MutationContext,
    resourceType: string,
    resourceId: string,
    action: string,
    details: Readonly<Record<string, unknown>>,
  ): void {
    const payload = serialize({
      action,
      ...details,
      resourceId,
      timestamp: context.now.toISOString(),
      traceId: context.traceId,
    });
    this.db.prepare(
      `INSERT INTO model_registry_events (
         event_id, resource_type, resource_id, action,
         payload_json, trace_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      context.eventId,
      resourceType,
      resourceId,
      action,
      payload,
      context.traceId,
      context.now.toISOString(),
    );
  }

  private immediate<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function assertConnectionRevisionOwner(
  connectionId: ProviderConnectionId,
  revision: ProviderConnectionRevision,
): void {
  if (revision.connectionId !== connectionId) {
    throw new DomainError("connection_revision_owner_mismatch");
  }
}

function assertProfileRevisionOwner(
  profileId: ModelProfileId,
  revision: ModelProfileRevision,
): void {
  if (revision.profileId !== profileId) {
    throw new DomainError("profile_revision_owner_mismatch");
  }
}

function throwRevisionConflict(): never {
  throw new ApplicationError("revision_conflict", 409);
}

function serialize(value: unknown): string {
  const result = canonicalizeJson(value);
  if (result === undefined) throw new Error("value_not_canonicalizable");
  return result;
}

function parseNullableDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function mapConnectionRevision(row: ConnectionRevisionRow): ProviderConnectionRevision {
  return {
    revisionId: row.revision_id as ProviderConnectionRevisionId,
    connectionId: row.connection_id as ProviderConnectionId,
    state: row.state,
    baseUrl: row.base_url,
    auth: JSON.parse(row.auth_json) as ProviderAuth,
    allowInsecureHttp: row.allow_insecure_http === 1,
    protocolPreference: row.protocol_preference,
    presetVersion: row.preset_version,
    createdAt: new Date(row.created_at),
  };
}

function mapProfileRevision(row: ProfileRevisionRow): ModelProfileRevision {
  return {
    revisionId: row.revision_id as ModelProfileRevisionId,
    profileId: row.profile_id as ModelProfileId,
    connectionRevisionId: row.connection_revision_id as ProviderConnectionRevisionId,
    state: row.state,
    providerModelId: row.provider_model_id,
    invocationProtocol: row.invocation_protocol,
    maxInputTokens: row.max_input_tokens,
    contextWindowSource: row.context_window_source,
    capabilityBaseline: row.capability_baseline,
    verifiedCapabilities: JSON.parse(
      row.verified_capabilities_json,
    ) as ModelProfileRevision["verifiedCapabilities"],
    createdAt: new Date(row.created_at),
  };
}

function mapVerification(row: VerificationRow): ModelVerification {
  return {
    verificationId: row.verification_id as ModelVerificationId,
    profileRevisionId: row.profile_revision_id as ModelProfileRevisionId,
    capabilityBaseline: row.capability_baseline,
    state: row.state,
    attemptCount: row.attempt_count,
    capabilities: JSON.parse(
      row.capabilities_json,
    ) as ModelVerification["capabilities"],
    ...(row.result_code === null
      ? {}
      : { resultCode: row.result_code as NonNullable<ModelVerification["resultCode"]> }),
    ...(row.safe_status === null ? {} : { safeStatus: row.safe_status }),
    ...(row.usage_json === null
      ? {}
      : { usage: JSON.parse(row.usage_json) as NonNullable<ModelVerification["usage"]> }),
    traceId: row.trace_id,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: parseNullableDate(row.lease_expires_at),
    cancellationRequestedAt: parseNullableDate(row.cancellation_requested_at),
    fallbackVerificationId:
      row.fallback_verification_id as ModelVerificationId | null,
    recordRevision: row.record_revision,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function mapAssignment(row: AssignmentRow): ModelAssignment {
  return {
    agentId: row.agent_id as AgentId,
    modelProfileRevisionId: row.model_profile_revision_id as ModelProfileRevisionId,
    source: row.source,
    recordRevision: row.record_revision,
    updatedAt: new Date(row.updated_at),
  };
}
