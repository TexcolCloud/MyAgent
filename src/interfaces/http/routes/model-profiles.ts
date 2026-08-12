import type { FastifyInstance } from "fastify";

import type { ListProviderDriversService } from "../../../application/list-provider-drivers.js";
import { manualModelEntryAllowed } from "../../../application/discover-models.js";
import type { ManageModelProfilesService } from "../../../application/manage-model-profiles.js";
import {
  PI_RUNTIME_VERSION,
  resolveProviderCatalogCandidate,
} from "../../../config/pi-runtime-catalog.js";
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
    readonly providerDrivers: ListProviderDriversService;
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
      const discovery = services.registry.getDiscoveredModels(connectionRevisionId, now);
      const resolved = "catalogCandidateId" in body
        ? resolveCatalogSelection(
          services,
          target.providerDriver,
          target.revision.auth.type,
          body,
        )
        : resolveManualSelection(
          target.providerKind,
          target.providerDriver,
          target.revision.protocolPreference,
          body,
        );
      assertModelSelection(discovery, resolved.modelId, resolved.manualEntryAcknowledged);
      const profileId = parseModelProfileId(body.slug);
      const result = createProfileOrConflict(services, profileId, () =>
        services.profiles.create({
          profileId,
          displayName: body.displayName,
          connectionRevisionId,
          providerModelId: resolved.modelId,
          invocationProtocol: resolved.invocationProtocol,
          ...(resolved.piRuntime === undefined
            ? {}
            : { piRuntime: resolved.piRuntime }),
          ...resolved.context,
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

function resolveCatalogSelection(
  services: { readonly providerDrivers: ListProviderDriversService },
  providerDriver: string | undefined,
  credentialSupport: "bearer" | "none",
  body: {
    readonly catalogCandidateId: string;
    readonly maxInputTokens?: number | undefined;
    readonly contextWindowSource?: ModelProfileRevision["contextWindowSource"] | undefined;
  },
) {
  const candidate = services.providerDrivers.resolveSupportedCandidate(
    body.catalogCandidateId,
  );
  if (providerDriver !== candidate.driverId) {
    throw new DomainError("invalid_model_profile");
  }
  services.providerDrivers.assertCandidateCredentialSupport(candidate, credentialSupport);
  return {
    piRuntime: { kind: "pi_ai" as const, ...candidate.invocation },
    modelId: candidate.modelId,
    invocationProtocol: "pi_ai" as const,
    manualEntryAcknowledged: false,
    context: resolveCatalogContext(
      candidate.invocation.contextWindow,
      body.maxInputTokens,
      body.contextWindowSource,
    ),
  };
}

function resolveCatalogContext(
  catalogContextWindow: number,
  maxInputTokens: number | undefined,
  source: ModelProfileRevision["contextWindowSource"] | undefined,
): Pick<ModelProfileRevision, "maxInputTokens" | "contextWindowSource"> {
  if (
    (source === undefined && maxInputTokens === undefined) ||
    (
      source === "preset" &&
      (maxInputTokens === undefined || maxInputTokens === catalogContextWindow)
    )
  ) {
    return {
      maxInputTokens: catalogContextWindow,
      contextWindowSource: "preset",
    };
  }
  if (
    source === "operator" &&
    maxInputTokens !== undefined &&
    maxInputTokens <= catalogContextWindow
  ) {
    return { maxInputTokens, contextWindowSource: "operator" };
  }
  if (
    source === "assumed_32768" &&
    maxInputTokens === 32_768 &&
    maxInputTokens <= catalogContextWindow
  ) {
    return { maxInputTokens, contextWindowSource: "assumed_32768" };
  }
  throw new DomainError("invalid_model_context_window");
}

function resolveManualSelection(
  providerKind: ProviderKind,
  providerDriver: string | undefined,
  protocolPreference: "chat_completions" | "responses" | "pi_ai",
  body: {
    readonly modelId: string;
    readonly protocol: "auto" | "chat_completions" | "responses";
    readonly maxInputTokens?: number | undefined;
    readonly contextWindowSource?: ModelProfileRevision["contextWindowSource"] | undefined;
    readonly manualEntryAcknowledged?: boolean | undefined;
  },
) {
  if (providerDriver !== "pi/openai-compatible") {
    throw new DomainError("invalid_model_profile");
  }
  const manualEntryAcknowledged = body.manualEntryAcknowledged === true;
  const invocationProtocol = body.protocol === "auto"
    ? protocolPreference
    : body.protocol;
  const context = resolveContext(
    providerKind,
    body.modelId,
    body.maxInputTokens,
    body.contextWindowSource,
  );
  return {
    piRuntime: {
      kind: "pi_ai" as const,
      piVersion: PI_RUNTIME_VERSION,
      driverId: "pi/openai-compatible" as const,
      catalogProviderId: "openai-compatible",
      api: invocationProtocol === "responses" ? "openai-responses" : "openai-completions",
      modelId: body.modelId,
      contextWindow: context.maxInputTokens,
      compatibility: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: false,
        maxTokensField: "max_tokens",
        requiresToolResultName: false,
        requiresAssistantAfterToolResult: false,
        requiresThinkingAsText: false,
        requiresReasoningContentOnAssistantMessages: false,
        thinkingFormat: "openai",
        zaiToolStream: false,
        supportsStrictMode: false,
        sendSessionAffinityHeaders: false,
        sendSessionIdHeader: false,
        supportsLongCacheRetention: false,
      },
    },
    modelId: body.modelId,
    invocationProtocol,
    manualEntryAcknowledged,
    context,
  };
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
    revisions: profile.revisions.map((revision) => {
      const { piRuntime, ...safeRevision } = revision;
      const catalogCandidate = piRuntime === undefined
        ? undefined
        : resolveProviderCatalogCandidate(piRuntime.driverId, piRuntime.modelId);
      return {
        ...safeRevision,
        ...(catalogCandidate === undefined
          ? {}
          : {
              catalogCandidateId: catalogCandidate.candidateId,
            }),
        createdAt: revision.createdAt.toISOString(),
      };
    }),
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
