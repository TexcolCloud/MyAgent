import { DomainError } from "../domain/errors.js";
import type {
  ModelProfileId,
  ModelProfileRevisionId,
  ProviderConnectionRevisionId,
} from "../domain/ids.js";
import { MODEL_CAPABILITY_BASELINE, type InvocationProtocol } from "../domain/model-registry.js";
import type {
  ModelProfileRevision,
  ModelProfileView,
} from "../domain/model-profile.js";
import type { PiRuntimeContract } from "../domain/pi-runtime.js";
import type { Clock } from "../ports/clock.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type { ModelRegistryStore } from "../ports/model-registry-store.js";

type ProfileManagementRegistry = Pick<
  ModelRegistryStore,
  | "createProfile"
  | "createProfileRevision"
  | "getProfile"
  | "promoteProfile"
  | "purgeProfile"
  | "retireProfile"
>;

export interface ModelProfileDraftValues {
  readonly connectionRevisionId: ProviderConnectionRevisionId;
  readonly providerModelId: string;
  readonly invocationProtocol: InvocationProtocol;
  readonly piRuntime?: PiRuntimeContract;
  readonly maxInputTokens: number;
  readonly contextWindowSource: ModelProfileRevision["contextWindowSource"];
}

export interface CreateModelProfileInput extends ModelProfileDraftValues {
  readonly profileId: ModelProfileId;
  readonly displayName: string;
  readonly traceId: string;
}

export interface ReviseModelProfileInput extends ModelProfileDraftValues {
  readonly profileId: ModelProfileId;
  readonly expectedRevision: number;
  readonly displayName?: string;
  readonly traceId: string;
}

export interface MutateModelProfileInput {
  readonly profileId: ModelProfileId;
  readonly expectedRevision: number;
  readonly traceId: string;
}

export interface PromoteModelProfileInput extends MutateModelProfileInput {
  readonly profileRevisionId: ModelProfileRevisionId;
}

export interface PrepareVerificationCandidateInput {
  readonly profileId: ModelProfileId;
  readonly profileRevisionId: ModelProfileRevisionId;
  readonly expectedRevision: number;
  readonly traceId: string;
}

export type PreparedVerificationCandidate =
  | {
      readonly kind: "draft";
      readonly revision: ModelProfileRevision;
      readonly expectedRevision: number;
    }
  | {
      readonly kind: "legacy_copy";
      readonly legacyProfileRevisionId: ModelProfileRevisionId;
      readonly candidateRevisionId: ModelProfileRevisionId;
      readonly expectedRevision: number;
    };

export class ManageModelProfilesService {
  constructor(
    private readonly registry: ProfileManagementRegistry,
    private readonly clock: Pick<Clock, "now">,
    private readonly ids: Pick<
      IdGenerator,
      "modelProfileRevisionId" | "modelRegistryEventId"
    >,
  ) {}

  create(input: CreateModelProfileInput): ModelProfileView {
    const now = this.clock.now();
    return this.registry.createProfile({
      profileId: input.profileId,
      displayName: requiredText(input.displayName),
      revision: this.draftRevision(input.profileId, input, now),
      eventId: this.ids.modelRegistryEventId(),
      traceId: input.traceId,
      now,
    });
  }

  revise(input: ReviseModelProfileInput): ModelProfileView {
    const now = this.clock.now();
    return this.registry.createProfileRevision({
      profileId: input.profileId,
      expectedRevision: input.expectedRevision,
      ...(input.displayName === undefined
        ? {}
        : { displayName: requiredText(input.displayName) }),
      revision: this.draftRevision(input.profileId, input, now),
      eventId: this.ids.modelRegistryEventId(),
      traceId: input.traceId,
      now,
    });
  }

  promote(input: PromoteModelProfileInput): ModelProfileView {
    return this.registry.promoteProfile({
      profileId: input.profileId,
      revisionId: input.profileRevisionId,
      expectedRevision: input.expectedRevision,
      eventId: this.ids.modelRegistryEventId(),
      traceId: input.traceId,
      now: this.clock.now(),
    });
  }

  retire(input: MutateModelProfileInput): ModelProfileView {
    return this.registry.retireProfile({
      ...input,
      eventId: this.ids.modelRegistryEventId(),
      now: this.clock.now(),
    });
  }

  purge(input: MutateModelProfileInput): void {
    this.registry.purgeProfile({
      ...input,
      eventId: this.ids.modelRegistryEventId(),
      now: this.clock.now(),
    });
  }

  prepareVerificationCandidate(
    input: PrepareVerificationCandidateInput,
  ): PreparedVerificationCandidate {
    const profile = this.registry.getProfile(input.profileId);
    const revision = profile.revisions.find(
      (candidate) => candidate.revisionId === input.profileRevisionId,
    );
    if (revision === undefined) {
      throw new DomainError("profile_revision_owner_mismatch");
    }
    if (revision.state === "legacy_trusted") {
      return {
        kind: "legacy_copy",
        legacyProfileRevisionId: revision.revisionId,
        candidateRevisionId: this.ids.modelProfileRevisionId(),
        expectedRevision: input.expectedRevision,
      };
    }
    if (revision.state !== "draft") {
      throw new DomainError("verification_required");
    }
    return { kind: "draft", revision, expectedRevision: input.expectedRevision };
  }

  private draftRevision(
    profileId: ModelProfileId,
    input: ModelProfileDraftValues,
    now: Date,
  ): ModelProfileRevision {
    if (!Number.isSafeInteger(input.maxInputTokens) || input.maxInputTokens <= 0) {
      throw new DomainError("invalid_model_context_window");
    }
    return Object.freeze({
      revisionId: this.ids.modelProfileRevisionId(),
      profileId,
      connectionRevisionId: input.connectionRevisionId,
      providerModelId: requiredText(input.providerModelId),
      invocationProtocol: input.invocationProtocol,
      ...(input.piRuntime === undefined
        ? {}
        : { piRuntime: freezePiRuntime(input.piRuntime) }),
      maxInputTokens: input.maxInputTokens,
      contextWindowSource: input.contextWindowSource,
      capabilityBaseline: MODEL_CAPABILITY_BASELINE,
      verifiedCapabilities: Object.freeze([]),
      state: "draft",
      createdAt: now,
    });
  }
}

function requiredText(value: string): string {
  if (value.trim().length === 0) throw new DomainError("invalid_model_profile");
  return value;
}

function freezePiRuntime(runtime: PiRuntimeContract): PiRuntimeContract {
  return Object.freeze({
    ...runtime,
    providerCompatibilityContract: runtime.providerCompatibilityContract,
    compatibility: Object.freeze({ ...runtime.compatibility }),
  });
}
