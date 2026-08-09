import canonicalizeModule from "canonicalize";
import type { DatabaseSync } from "node:sqlite";

import { ApplicationError, DomainError } from "../../domain/errors.js";
import type {
  AgentId,
  ManagedSecretVersionId,
  ModelProfileId,
  ModelProfileRevisionId,
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
import type {
  ProviderAuth,
  ProviderConnectionRevision,
  ProviderConnectionView,
} from "../../domain/provider-connection.js";
import type {
  CoreModelRegistryStore,
  CreateConnectionRecord,
  CreateConnectionRevisionRecord,
  CreateProfileRecord,
  MutationContext,
  PromoteConnectionInput,
  PromoteProfileInput,
  PurgeConnectionInput,
  PurgeProfileInput,
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
    assertConnectionRevisionOwner(input.connectionId, input.revision);
    return this.immediate(() => {
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

  listConnections(): readonly ProviderConnectionView[] {
    const rows = this.db.prepare(
      "SELECT connection_id FROM provider_connections ORDER BY connection_id",
    ).all() as unknown as Array<{ connection_id: string }>;
    return rows.map(({ connection_id }) =>
      this.getConnection(connection_id as ProviderConnectionId));
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

  promoteConnection(input: PromoteConnectionInput): ProviderConnectionView {
    return this.immediate(() => {
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
      this.assertProfileDefaultEligible(input.profileId);
      const existing = this.defaultRow();
      let newRevision: number;
      if (existing === undefined) {
        if (input.expectedRevision !== 0) throwRevisionConflict();
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
      this.assertAssignmentEligible(input.profileRevisionId);
      const existing = this.assignmentRow(input.agentId);
      let newRevision: number;
      if (existing === undefined) {
        if (input.expectedRevision !== 0) throwRevisionConflict();
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
       WHERE revision_id = ? AND connection_id = ?`,
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

function mapAssignment(row: AssignmentRow): ModelAssignment {
  return {
    agentId: row.agent_id as AgentId,
    modelProfileRevisionId: row.model_profile_revision_id as ModelProfileRevisionId,
    source: row.source,
    recordRevision: row.record_revision,
    updatedAt: new Date(row.updated_at),
  };
}
