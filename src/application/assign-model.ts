import { ApplicationError, DomainError } from "../domain/errors.js";
import type {
  AgentId,
  ModelProfileId,
  ModelProfileRevisionId,
} from "../domain/ids.js";
import { assertNewAssignmentEligible } from "../domain/model-assignment.js";
import type { ModelAssignment } from "../domain/model-assignment.js";
import type { Clock } from "../ports/clock.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type { ModelRegistryStore } from "../ports/model-registry-store.js";

type AssignmentRegistry = Pick<
  ModelRegistryStore,
  | "getAssignment"
  | "getDefaultProfile"
  | "getProfile"
  | "listProfiles"
  | "setAssignment"
  | "setDefaultProfile"
  | "synchronizeAgents"
>;

export class AssignModelService {
  constructor(
    private readonly registry: AssignmentRegistry,
    private readonly clock: Pick<Clock, "now">,
    private readonly ids: Pick<IdGenerator, "modelRegistryEventId">,
  ) {}

  setDefault(input: {
    readonly profileId: ModelProfileId;
    readonly expectedRevision: number;
    readonly traceId: string;
  }) {
    assertExpectedRevision(
      this.registry.getDefaultProfile()?.recordRevision,
      input.expectedRevision,
    );
    const profile = this.registry.getProfile(input.profileId);
    const activeRevision = profile.revisions.find(
      ({ revisionId }) => revisionId === profile.activeRevisionId,
    );
    if (activeRevision === undefined) throw new DomainError("verification_required");
    assertNewAssignmentEligible(activeRevision);
    return this.registry.setDefaultProfile({
      ...input,
      eventId: this.ids.modelRegistryEventId(),
      now: this.clock.now(),
    });
  }

  assign(input: {
    readonly agentId: AgentId;
    readonly profileRevisionId: ModelProfileRevisionId;
    readonly expectedRevision: number;
    readonly traceId: string;
  }): ModelAssignment {
    assertExpectedRevision(
      this.registry.getAssignment(input.agentId)?.recordRevision,
      input.expectedRevision,
    );
    const profile = this.registry.listProfiles().find(
      ({ revisions }) => revisions.some(
        ({ revisionId }) => revisionId === input.profileRevisionId,
      ),
    );
    const revision = profile?.revisions.find(
      ({ revisionId }) => revisionId === input.profileRevisionId,
    );
    if (profile?.activeRevisionId !== input.profileRevisionId || revision === undefined) {
      throw new DomainError("verification_required");
    }
    assertNewAssignmentEligible(revision);
    return this.registry.setAssignment({
      ...input,
      source: "explicit",
      eventId: this.ids.modelRegistryEventId(),
      now: this.clock.now(),
    });
  }

  synchronizeAgents(agentIds: readonly AgentId[]): readonly ModelAssignment[] {
    const seen = new Set<AgentId>();
    const agents = [];
    for (const agentId of agentIds) {
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      agents.push({
        agentId,
        eventId: this.ids.modelRegistryEventId(),
      });
    }
    return this.registry.synchronizeAgents({
      agents,
      traceId: "catalog.synchronize_agents",
      now: this.clock.now(),
    });
  }
}

function assertExpectedRevision(
  currentRevision: number | undefined,
  expectedRevision: number,
): void {
  if (
    (currentRevision === undefined && expectedRevision !== 0) ||
    (currentRevision !== undefined && currentRevision !== expectedRevision)
  ) {
    throw new ApplicationError("revision_conflict", 409);
  }
}
