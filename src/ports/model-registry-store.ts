import type { ModelUsage } from "./model.js";
import type {
  AgentId,
  DiscoveryGenerationId,
  ManagedSecretVersionId,
  ModelProfileId,
  ModelProfileRevisionId,
  ModelRegistryEventId,
  ModelVerificationId,
  ProviderConnectionId,
  ProviderConnectionRevisionId,
} from "../domain/ids.js";
import type { SecretReferenceOwner } from "../domain/managed-secret.js";
import type { VerificationResultCode } from "../domain/errors.js";
import type {
  DefaultModelProfile,
  ModelAssignment,
} from "../domain/model-assignment.js";
import type {
  ModelProfileRevision,
  ModelProfileView,
} from "../domain/model-profile.js";
import type { DiscoveryView, ProviderKind } from "../domain/model-registry.js";
import type { ModelVerification } from "../domain/model-verification.js";
import type {
  ProviderConnectionRevision,
  ProviderConnectionView,
} from "../domain/provider-connection.js";

export interface MutationContext {
  readonly eventId: ModelRegistryEventId;
  readonly traceId: string;
  readonly now: Date;
}

export interface CreateConnectionRecord extends MutationContext {
  readonly connectionId: ProviderConnectionId;
  readonly displayName: string;
  readonly providerKind: ProviderKind;
  readonly revision: ProviderConnectionRevision;
}

export interface CreateConnectionRevisionRecord extends MutationContext {
  readonly connectionId: ProviderConnectionId;
  readonly expectedRevision: number;
  readonly displayName?: string;
  readonly revision: ProviderConnectionRevision;
}

export interface RecordDiscoveryInput extends MutationContext {
  readonly connectionRevisionId: ProviderConnectionRevisionId;
  readonly generationId: DiscoveryGenerationId;
  readonly expectedRevision: number;
  readonly state: "fresh" | "empty" | "unsupported" | "failed";
  readonly models: DiscoveryView["models"];
  readonly expiresAt?: Date;
  readonly error?: { readonly code: string; readonly status?: number };
}

export interface CreateProfileRecord extends MutationContext {
  readonly profileId: ModelProfileId;
  readonly displayName: string;
  readonly revision: ModelProfileRevision;
}

export interface CreateProfileRevisionRecord extends MutationContext {
  readonly profileId: ModelProfileId;
  readonly expectedRevision: number;
  readonly displayName?: string;
  readonly revision: ModelProfileRevision;
}

export interface QueueVerificationRecord extends MutationContext {
  readonly verificationId: ModelVerificationId;
  readonly profileRevisionId: ModelProfileRevisionId;
  readonly expectedRevision: number;
  readonly capabilityBaseline: ModelProfileRevision["capabilityBaseline"];
}

export interface QueueLegacyProfileVerificationRecord extends MutationContext {
  readonly profileId: ModelProfileId;
  readonly legacyProfileRevisionId: ModelProfileRevisionId;
  readonly candidateRevisionId: ModelProfileRevisionId;
  readonly verificationId: ModelVerificationId;
  readonly verificationEventId: ModelRegistryEventId;
  readonly expectedRevision: number;
}

export interface ClaimVerificationInput {
  readonly leaseOwner: string;
  readonly now: Date;
  readonly leaseUntil: Date;
}

export interface BeginVerificationAttemptInput {
  readonly verificationId: ModelVerificationId;
  readonly leaseOwner: string;
  readonly now: Date;
}

export interface RenewVerificationLeaseInput {
  readonly verificationId: ModelVerificationId;
  readonly leaseOwner: string;
  readonly now: Date;
  readonly leaseUntil: Date;
}

export interface CompleteVerificationInput extends MutationContext {
  readonly verificationId: ModelVerificationId;
  readonly leaseOwner: string;
  readonly outcome: "passed" | "failed";
  readonly capabilities: ModelVerification["capabilities"];
  readonly resultCode?: VerificationResultCode;
  readonly safeStatus?: number;
  readonly usage?: ModelUsage;
  readonly fallback?: {
    readonly revision: ModelProfileRevision;
    readonly verification: QueueVerificationRecord;
  };
}

export interface CancelVerificationInput extends MutationContext {
  readonly verificationId: ModelVerificationId;
  readonly expectedRevision: number;
}

export interface PromoteConnectionInput extends MutationContext {
  readonly connectionId: ProviderConnectionId;
  readonly revisionId: ProviderConnectionRevisionId;
  readonly expectedRevision: number;
}

export interface PromoteProfileInput extends MutationContext {
  readonly profileId: ModelProfileId;
  readonly revisionId: ModelProfileRevisionId;
  readonly expectedRevision: number;
}

export interface SetDefaultProfileInput extends MutationContext {
  readonly profileId: ModelProfileId;
  readonly expectedRevision: number;
}

export interface SetModelAssignmentInput extends MutationContext {
  readonly agentId: AgentId;
  readonly profileRevisionId: ModelProfileRevisionId;
  readonly source: "explicit" | "default";
  readonly expectedRevision: number;
}

export interface SynchronizeAgentInput {
  readonly agentId: AgentId;
  readonly eventId: ModelRegistryEventId;
}

export interface SynchronizeAgentsInput {
  readonly agents: readonly SynchronizeAgentInput[];
  readonly traceId: string;
  readonly now: Date;
}

export interface RetireConnectionInput extends MutationContext {
  readonly connectionId: ProviderConnectionId;
  readonly expectedRevision: number;
}

export interface RetireProfileInput extends MutationContext {
  readonly profileId: ModelProfileId;
  readonly expectedRevision: number;
}

export interface PurgeConnectionInput extends MutationContext {
  readonly connectionId: ProviderConnectionId;
  readonly expectedRevision: number;
}

export interface PurgeProfileInput extends MutationContext {
  readonly profileId: ModelProfileId;
  readonly expectedRevision: number;
}

export interface RecordProviderHealthInput {
  readonly connectionRevisionId: ProviderConnectionRevisionId;
  readonly profileRevisionId?: ModelProfileRevisionId;
  readonly outcome: "success" | "failure";
  readonly code?: string;
  readonly safeStatus?: number;
  readonly traceId: string;
  readonly observedAt: Date;
}

export interface ExactProviderConnectionRevision {
  readonly providerKind: ProviderKind;
  readonly revision: ProviderConnectionRevision;
}

export interface LegacyModelSeed {
  readonly alias: string;
  readonly providerKind: ProviderKind;
  readonly baseUrl: string;
  readonly apiKey: { readonly fromEnvironment: string };
  readonly modelId: string;
  readonly maxInputTokens: number;
}

export interface LegacyModelImportSeed {
  readonly sourceSha256: string;
  readonly models: Readonly<Record<string, Omit<LegacyModelSeed, "alias">>>;
  readonly agentAliases: Readonly<Record<string, string>>;
}

export interface LegacyImportRecord extends MutationContext {
  readonly migrationVersion: 1;
  readonly sourceSha256: string;
  readonly models: readonly LegacyModelSeed[];
  readonly agentAliases: Readonly<Record<string, string>>;
}

export interface LegacyImportResult {
  readonly sourceSha256: string;
  readonly aliases: Readonly<Record<string, {
    readonly connectionId: ProviderConnectionId;
    readonly profileId: ModelProfileId;
    readonly revisionId: ModelProfileRevisionId;
  }>>;
  readonly assignments: readonly ModelAssignment[];
  readonly created: boolean;
}

export interface ModelRegistryStore {
  createConnection(input: CreateConnectionRecord): ProviderConnectionView;
  createConnectionRevision(input: CreateConnectionRevisionRecord): ProviderConnectionView;
  getConnection(id: ProviderConnectionId): ProviderConnectionView;
  getConnectionRevision(
    id: ProviderConnectionRevisionId,
  ): ExactProviderConnectionRevision | null;
  listConnections(): readonly ProviderConnectionView[];
  recordDiscovery(input: RecordDiscoveryInput): DiscoveryView;
  getDiscoveredModels(revisionId: ProviderConnectionRevisionId, now: Date): DiscoveryView;
  createProfile(input: CreateProfileRecord): ModelProfileView;
  createProfileRevision(input: CreateProfileRevisionRecord): ModelProfileView;
  getProfile(id: ModelProfileId): ModelProfileView;
  listProfiles(): readonly ModelProfileView[];
  queueLegacyProfileVerification(
    input: QueueLegacyProfileVerificationRecord,
  ): ModelVerification;
  queueVerification(input: QueueVerificationRecord): ModelVerification;
  claimVerification(input: ClaimVerificationInput): ModelVerification | null;
  beginVerificationAttempt(input: BeginVerificationAttemptInput): ModelVerification;
  renewVerificationLease(input: RenewVerificationLeaseInput): boolean;
  completeVerification(input: CompleteVerificationInput): ModelVerification;
  cancelVerification(input: CancelVerificationInput): ModelVerification;
  getVerification(id: ModelVerificationId): ModelVerification;
  promoteConnection(input: PromoteConnectionInput): ProviderConnectionView;
  promoteProfile(input: PromoteProfileInput): ModelProfileView;
  setDefaultProfile(input: SetDefaultProfileInput): DefaultModelProfile;
  getDefaultProfile(): DefaultModelProfile | null;
  setAssignment(input: SetModelAssignmentInput): ModelAssignment;
  getAssignment(agentId: AgentId): ModelAssignment | null;
  synchronizeAgents(input: SynchronizeAgentsInput): readonly ModelAssignment[];
  retireConnection(input: RetireConnectionInput): ProviderConnectionView;
  retireProfile(input: RetireProfileInput): ModelProfileView;
  purgeConnection(input: PurgeConnectionInput): void;
  purgeProfile(input: PurgeProfileInput): void;
  inspectSecretReferences(versionId: ManagedSecretVersionId): readonly SecretReferenceOwner[];
  recordProviderHealth(input: RecordProviderHealthInput): void;
  importLegacy(input: LegacyImportRecord): LegacyImportResult;
}

export type CoreModelRegistryStore = Pick<
  ModelRegistryStore,
  | "createConnection"
  | "createConnectionRevision"
  | "getConnection"
  | "getConnectionRevision"
  | "listConnections"
  | "createProfile"
  | "createProfileRevision"
  | "getProfile"
  | "listProfiles"
  | "queueLegacyProfileVerification"
  | "promoteConnection"
  | "promoteProfile"
  | "setDefaultProfile"
  | "getDefaultProfile"
  | "setAssignment"
  | "getAssignment"
  | "synchronizeAgents"
  | "retireConnection"
  | "retireProfile"
  | "purgeConnection"
  | "purgeProfile"
  | "inspectSecretReferences"
  | "recordDiscovery"
  | "getDiscoveredModels"
  | "queueVerification"
  | "claimVerification"
  | "beginVerificationAttempt"
  | "renewVerificationLease"
  | "completeVerification"
  | "cancelVerification"
  | "getVerification"
  | "recordProviderHealth"
>;
