import { createHash } from "node:crypto";

import canonicalizeModule from "canonicalize";

import type { CatalogService } from "../config/catalog-service.js";
import {
  type AgentResolverPort,
  type AgentRevisionSnapshot,
  type EffectiveModelRuntime,
} from "../domain/agent-revision.js";
import { ApplicationError } from "../domain/errors.js";
import type { AgentId } from "../domain/ids.js";
import { assertExistingAssignmentUsable } from "../domain/model-assignment.js";
import type { ModelRegistryStore } from "../ports/model-registry-store.js";
import type { SecretResolver } from "../ports/secret-resolver.js";

const canonicalizeJson = canonicalizeModule as unknown as (
  input: unknown,
) => string | undefined;

export interface AgentResolverOptions {
  readonly catalog: Pick<CatalogService, "resolve">;
  readonly registry: Pick<
    ModelRegistryStore,
    "getAssignment" | "listProfiles" | "listConnections"
  >;
  readonly secrets: Pick<SecretResolver, "resolve">;
}

export class AgentResolver implements AgentResolverPort {
  constructor(private readonly options: AgentResolverOptions) {}

  resolve(agentId: AgentId): AgentRevisionSnapshot {
    const definition = this.options.catalog.resolve(agentId).definition;
    const assignment = this.options.registry.getAssignment(agentId);
    if (assignment === null) {
      throw new ApplicationError("model_assignment_required", 422);
    }
    const profileRevision = this.options.registry
      .listProfiles()
      .flatMap((profile) => profile.revisions)
      .find((revision) => revision.revisionId === assignment.modelProfileRevisionId);
    if (profileRevision === undefined) {
      throw new ApplicationError("verification_required", 422);
    }
    try {
      assertExistingAssignmentUsable(assignment, profileRevision);
    } catch {
      throw new ApplicationError("verification_required", 422);
    }
    const connectionView = this.options.registry
      .listConnections()
      .find((connection) => connection.revisions.some(
        (revision) => revision.revisionId === profileRevision.connectionRevisionId,
      ));
    const connectionRevision = connectionView?.revisions.find(
      (revision) => revision.revisionId === profileRevision.connectionRevisionId,
    );
    if (connectionView === undefined || connectionRevision === undefined) {
      throw new ApplicationError("verification_required", 422);
    }
    const connectionUsable = assignment.source === "legacy_import"
      ? connectionRevision.state === "legacy_trusted"
      : connectionRevision.state === "active" ||
        connectionRevision.state === "superseded" ||
        connectionRevision.state === "retired";
    if (!connectionUsable) {
      throw new ApplicationError("verification_required", 422);
    }
    if (connectionRevision.auth.type === "bearer") {
      try {
        this.options.secrets.resolve(connectionRevision.auth.secret);
      } catch {
        throw new ApplicationError("model_provider_locked", 503);
      }
    }

    const model: EffectiveModelRuntime = {
      providerConnectionRevisionId: connectionRevision.revisionId,
      providerKind: connectionView.providerKind,
      baseUrl: connectionRevision.baseUrl,
      providerAuth: connectionRevision.auth,
      modelId: profileRevision.providerModelId,
      invocationProtocol: profileRevision.invocationProtocol,
      maxInputTokens: profileRevision.maxInputTokens,
      verifiedCapabilities: profileRevision.verifiedCapabilities,
      compatibilityPresetVersion: connectionRevision.presetVersion,
    };
    const content = {
      ...definition,
      modelProfileRevisionId: profileRevision.revisionId,
      model,
    };
    const canonical = canonicalizeJson(content);
    if (canonical === undefined) throw new Error("revision_not_canonicalizable");
    const contentSha256 = createHash("sha256").update(canonical).digest("hex");
    return deepFreeze({
      ...content,
      revisionId: `rev_${contentSha256}`,
      contentSha256,
    });
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
