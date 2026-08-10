import type { FastifyInstance } from "fastify";

import { manualModelEntryAllowed } from "../../../application/discover-models.js";
import type { ManageModelProfilesService } from "../../../application/manage-model-profiles.js";
import { modelContextPreset } from "../../../config/provider-presets.js";
import { ApplicationError } from "../../../domain/errors.js";
import { DomainError } from "../../../domain/errors.js";
import {
  parseModelProfileId,
  type ModelProfileRevisionId,
  type ProviderConnectionRevisionId,
} from "../../../domain/ids.js";
import type { ProviderKind } from "../../../domain/model-registry.js";
import type { ModelProfileRevision, ModelProfileView } from "../../../domain/model-profile.js";
import type { ModelRegistryStore } from "../../../ports/model-registry-store.js";
import {
  confirmedDestructionSchema,
  createModelProfileSchema,
  expectedRevisionSchema,
  modelProfileResponseSchema,
  modelProfilesResponseSchema,
  promoteModelProfileSchema,
} from "../model-control-schemas.js";
import { parseSchema } from "../schemas.js";

export function registerModelProfileRoutes(
  app: FastifyInstance,
  services: {
    readonly registry: Pick<
      ModelRegistryStore,
      | "getConnectionRevision"
      | "getDiscoveredModels"
      | "getProfile"
      | "listProfiles"
    >;
    readonly profiles: ManageModelProfilesService;
    readonly now?: () => Date;
  },
): void {
  app.post(
    "/model-profiles",
    { schema: { response: { 201: modelProfileResponseSchema } } },
    async (request, reply) => {
      const body = parseSchema(createModelProfileSchema, request.body);
      const connectionRevisionId = body.connectionRevisionId as ProviderConnectionRevisionId;
      const target = services.registry.getConnectionRevision(connectionRevisionId);
      if (target === null) throw new Error("provider_connection_revision_not_found");
      const now = services.now?.() ?? new Date();
      assertModelSelection(
        services.registry.getDiscoveredModels(connectionRevisionId, now),
        body.modelId,
        body.manualEntryAcknowledged === true,
      );
      const context = resolveContext(
        target.providerKind,
        body.modelId,
        body.maxInputTokens,
        body.contextWindowSource,
      );
      const profileId = parseModelProfileId(body.slug);
      const result = createProfileOrConflict(services, profileId, () =>
        services.profiles.create({
          profileId,
          displayName: body.displayName,
          connectionRevisionId,
          providerModelId: body.modelId,
          invocationProtocol: body.protocol === "auto"
            ? target.revision.protocolPreference
            : body.protocol,
          ...context,
          traceId: request.id,
        }));
      return reply.code(201).send(profileResponse(result));
    },
  );
  app.get(
    "/model-profiles",
    { schema: { response: { 200: modelProfilesResponseSchema } } },
    async () => ({
      profiles: services.registry.listProfiles().map(profileResponse),
    }),
  );
  app.get(
    "/model-profiles/:profileId",
    { schema: { response: { 200: modelProfileResponseSchema } } },
    async (request) => profileResponse(services.registry.getProfile(
      parseModelProfileId((request.params as { profileId: string }).profileId),
    )),
  );
  app.post(
    "/model-profiles/:profileId/promotions",
    { schema: { response: { 200: modelProfileResponseSchema } } },
    async (request) => {
      const profileId = parseModelProfileId(
        (request.params as { profileId: string }).profileId,
      );
      const body = parseSchema(promoteModelProfileSchema, request.body);
      assertProfileConnectionActive(
        services.registry,
        profileId,
        body.profileRevisionId as ModelProfileRevisionId,
        body.expectedRevision,
      );
      return profileResponse(services.profiles.promote({
        profileId,
        profileRevisionId: body.profileRevisionId as ModelProfileRevisionId,
        expectedRevision: body.expectedRevision,
        traceId: request.id,
      }));
    },
  );
  app.post(
    "/model-profiles/:profileId/retirement",
    { schema: { response: { 200: modelProfileResponseSchema } } },
    async (request) => {
      const profileId = parseModelProfileId(
        (request.params as { profileId: string }).profileId,
      );
      services.registry.getProfile(profileId);
      const body = parseSchema(expectedRevisionSchema, request.body);
      return profileResponse(services.profiles.retire({
        profileId,
        expectedRevision: body.expectedRevision,
        traceId: request.id,
      }));
    },
  );
  app.post(
    "/model-profiles/:profileId/purge",
    async (request, reply) => {
      const profileId = parseModelProfileId(
        (request.params as { profileId: string }).profileId,
      );
      services.registry.getProfile(profileId);
      const body = parseSchema(confirmedDestructionSchema, request.body);
      services.profiles.purge({
        profileId,
        expectedRevision: body.expectedRevision,
        traceId: request.id,
      });
      return reply.code(204).send();
    },
  );
}

function assertProfileConnectionActive(
  registry: Pick<ModelRegistryStore, "getConnectionRevision" | "getProfile">,
  profileId: ModelProfileView["profileId"],
  revisionId: ModelProfileRevisionId,
  expectedRevision: number,
): void {
  const profile = registry.getProfile(profileId);
  if (profile.recordRevision !== expectedRevision) {
    throw new ApplicationError("revision_conflict", 409);
  }
  const revision = profile.revisions.find((candidate) =>
    candidate.revisionId === revisionId);
  if (revision === undefined) throw new DomainError("profile_revision_owner_mismatch");
  const connection = registry.getConnectionRevision(revision.connectionRevisionId);
  if (connection === null) throw new Error("provider_connection_revision_not_found");
  if (connection.revision.state !== "active") {
    throw new DomainError("connection_revision_not_active");
  }
}

function assertModelSelection(
  discovery: ReturnType<ModelRegistryStore["getDiscoveredModels"]>,
  modelId: string,
  manualEntryAcknowledged: boolean,
): void {
  if (discovery.models.some(({ id }) => id === modelId)) return;
  if (manualEntryAcknowledged && manualModelEntryAllowed(discovery)) return;
  throw new DomainError("manual_model_entry_required");
}

function resolveContext(
  providerKind: ProviderKind,
  modelId: string,
  maxInputTokens: number | undefined,
  source: ModelProfileRevision["contextWindowSource"] | undefined,
): Pick<ModelProfileRevision, "maxInputTokens" | "contextWindowSource"> {
  const preset = modelContextPreset(providerKind, modelId);
  if (maxInputTokens === undefined && source === undefined && preset !== undefined) {
    return { maxInputTokens: preset, contextWindowSource: "preset" };
  }
  if (source === "operator" && maxInputTokens !== undefined) {
    return { maxInputTokens, contextWindowSource: "operator" };
  }
  if (source === "assumed_32768" && maxInputTokens === 32_768 && preset === undefined) {
    return { maxInputTokens, contextWindowSource: "assumed_32768" };
  }
  if (source === "preset" && maxInputTokens === preset && preset !== undefined) {
    return { maxInputTokens: preset, contextWindowSource: "preset" };
  }
  throw new DomainError("invalid_model_context_window");
}

function profileResponse(profile: ModelProfileView) {
  return {
    profileId: profile.profileId,
    displayName: profile.displayName,
    activeRevisionId: profile.activeRevisionId,
    retiredAt: profile.retiredAt?.toISOString() ?? null,
    recordRevision: profile.recordRevision,
    revisions: profile.revisions.map((revision) => ({
      ...revision,
      createdAt: revision.createdAt.toISOString(),
    })),
  };
}

function createProfileOrConflict(
  services: {
    readonly registry: Pick<ModelRegistryStore, "listProfiles">;
  },
  profileId: ModelProfileView["profileId"],
  create: () => ModelProfileView,
): ModelProfileView {
  try {
    return create();
  } catch (error) {
    if (services.registry.listProfiles().some(
      (profile) => profile.profileId === profileId,
    )) {
      throw new ApplicationError("resource_conflict", 409);
    }
    throw error;
  }
}
