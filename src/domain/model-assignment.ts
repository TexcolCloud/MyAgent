import { DomainError } from "./errors.js";
import type { AgentId, ModelProfileId, ModelProfileRevisionId } from "./ids.js";
import {
  hasBaselineCapabilities,
  type ModelProfileRevision,
} from "./model-profile.js";

export interface DefaultModelProfile {
  readonly profileId: ModelProfileId;
  readonly recordRevision: number;
}

export type AssignmentSource = "explicit" | "default" | "legacy_import";

export interface ModelAssignment {
  readonly agentId: AgentId;
  readonly modelProfileRevisionId: ModelProfileRevisionId;
  readonly source: AssignmentSource;
  readonly recordRevision: number;
  readonly updatedAt: Date;
}

export function assertNewAssignmentEligible(
  revision: ModelProfileRevision,
): void {
  if (revision.state === "active" && hasBaselineCapabilities(revision)) return;
  throw new DomainError(
    revision.state === "legacy_trusted"
      ? "legacy_assignment_forbidden"
      : "verification_required",
  );
}

export function assertExistingAssignmentUsable(
  assignment: ModelAssignment,
  revision: ModelProfileRevision,
): void {
  if (assignment.modelProfileRevisionId !== revision.revisionId) {
    throw new DomainError("verification_required");
  }
  if (assignment.source === "legacy_import" && revision.state === "legacy_trusted") {
    return;
  }
  if (
    (revision.state === "active" ||
      revision.state === "superseded" ||
      revision.state === "retired") &&
    hasBaselineCapabilities(revision)
  ) {
    return;
  }
  throw new DomainError("verification_required");
}
