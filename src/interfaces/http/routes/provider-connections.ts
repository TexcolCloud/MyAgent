import type { FastifyInstance } from "fastify";
import type { z } from "zod";

import type {
  ListProviderDriversService,
} from "../../../application/list-provider-drivers.js";
import type {
  ManageProviderConnectionsService,
  ProviderCredentialInput,
} from "../../../application/manage-provider-connections.js";
import type { DiscoverModelsService } from "../../../application/discover-models.js";
import { ApplicationError, DomainError } from "../../../domain/errors.js";
import {
  parseProviderConnectionId,
  type ManagedSecretVersionId,
  type ProviderConnectionRevisionId,
} from "../../../domain/ids.js";
import type { DiscoveryView } from "../../../domain/model-registry.js";
import type { ProviderDriverId } from "../../../domain/pi-runtime.js";
import type {
  ProviderAuth,
  ProviderConnectionRevision,
  ProviderConnectionView,
} from "../../../domain/provider-connection.js";
import type { ModelRegistryStore } from "../../../ports/model-registry-store.js";
import {
  createProviderConnectionSchema,
  confirmedDestructionSchema,
  discoverModelsSchema,
  discoveryResponseSchema,
  expectedRevisionSchema,
  providerConnectionResponseSchema,
  providerConnectionsResponseSchema,
  promoteProviderConnectionSchema,
  reviseProviderConnectionSchema,
} from "../model-control-schemas.js";
import { parseSchema } from "../schemas.js";

export function registerProviderConnectionRoutes(
  app: FastifyInstance,
  services: {
    readonly registry: Pick<
      ModelRegistryStore,
      "getConnection" | "listConnections" | "getDiscoveredModels"
    >;
    readonly connections: ManageProviderConnectionsService;
    readonly providerDrivers: ListProviderDriversService;
    readonly discovery: DiscoverModelsService;
    readonly now?: () => Date;
  },
): void {
  app.post(
    "/provider-connections",
    { schema: { response: { 201: providerConnectionResponseSchema } } },
    async (request, reply) => {
      const body = parseSchema(createProviderConnectionSchema, request.body);
      const connectionId = parseProviderConnectionId(body.slug);
      const providerDriver = body.driverId === undefined
        ? undefined
        : services.providerDrivers.resolveSupportedDriver(
          body.driverId as ProviderDriverId,
        );
      if (providerDriver !== undefined) {
        services.providerDrivers.assertDriverCredentialSupport(
          providerDriver,
          credentialSupport(body.auth),
        );
      }
      const result = createConnectionOrConflict(services, connectionId, () =>
        services.connections.create({
          connectionId,
          displayName: body.displayName,
          providerKind: body.kind ?? "openai_compatible",
          ...(providerDriver === undefined ? {} : { providerDriver }),
          ...(body.baseUrl === undefined ? {} : { baseUrl: body.baseUrl }),
          credential: credentialInput(body.auth),
          ...(body.apiKey === undefined
            ? {}
            : {
                replacementApiKey: {
                  secretId: `provider:${connectionId}:api-key`,
                  plaintext: body.apiKey,
                },
              }),
          ...(body.allowInsecureHttp === undefined
            ? {}
            : { allowInsecureHttp: body.allowInsecureHttp }),
          ...(body.protocolPreference === undefined
            ? {}
            : { protocolPreference: body.protocolPreference }),
          traceId: request.id,
        }));
      return reply.code(201).send(connectionResponse(result));
    },
  );
  app.get(
    "/provider-connections",
    { schema: { response: { 200: providerConnectionsResponseSchema } } },
    async () => ({
      connections: services.registry.listConnections().map(connectionResponse),
    }),
  );
  app.get(
    "/provider-connections/:connectionId",
    { schema: { response: { 200: providerConnectionResponseSchema } } },
    async (request) => connectionResponse(services.registry.getConnection(
      parseProviderConnectionId(
        (request.params as { connectionId: string }).connectionId,
      ),
    )),
  );
  app.post(
    "/provider-connections/:connectionId/revisions",
    { schema: { response: { 200: providerConnectionResponseSchema } } },
    async (request) => {
      const connectionId = parseProviderConnectionId(
        (request.params as { connectionId: string }).connectionId,
      );
      const body = parseSchema(reviseProviderConnectionSchema, request.body);
      const connection = services.registry.getConnection(connectionId);
      if (body.driverId !== undefined) {
        const driverId = services.providerDrivers.resolveSupportedDriver(
          body.driverId as ProviderDriverId,
        );
        if (connection.providerDriver !== driverId) {
          throw new DomainError("invalid_provider_connection");
        }
      }
      if (connection.providerDriver !== undefined) {
        services.providerDrivers.assertDriverCredentialSupport(
          connection.providerDriver,
          credentialSupport(body.auth),
        );
      }
      return connectionResponse(services.connections.revise({
        connectionId,
        expectedRevision: body.expectedRevision,
        displayName: body.displayName,
        baseUrl: body.baseUrl,
        credential: credentialInput(body.auth),
        ...(body.apiKey === undefined
          ? {}
          : {
              replacementApiKey: {
                secretId: `provider:${connectionId}:api-key`,
                plaintext: body.apiKey,
              },
            }),
        allowInsecureHttp: body.allowInsecureHttp,
        protocolPreference: body.protocolPreference,
        traceId: request.id,
      }));
    },
  );
  app.post(
    "/provider-connections/:connectionId/promotions",
    { schema: { response: { 200: providerConnectionResponseSchema } } },
    async (request) => {
      const connectionId = parseProviderConnectionId(
        (request.params as { connectionId: string }).connectionId,
      );
      services.registry.getConnection(connectionId);
      const body = parseSchema(promoteProviderConnectionSchema, request.body);
      return connectionResponse(services.connections.promote({
        connectionId,
        connectionRevisionId: body.connectionRevisionId as
          ProviderConnectionRevisionId,
        expectedRevision: body.expectedRevision,
        traceId: request.id,
      }));
    },
  );
  app.post(
    "/provider-connections/:connectionId/retirement",
    { schema: { response: { 200: providerConnectionResponseSchema } } },
    async (request) => {
      const connectionId = parseProviderConnectionId(
        (request.params as { connectionId: string }).connectionId,
      );
      services.registry.getConnection(connectionId);
      const body = parseSchema(expectedRevisionSchema, request.body);
      return connectionResponse(services.connections.retire({
        connectionId,
        expectedRevision: body.expectedRevision,
        traceId: request.id,
      }));
    },
  );
  app.post(
    "/provider-connections/:connectionId/purge",
    async (request, reply) => {
      const connectionId = parseProviderConnectionId(
        (request.params as { connectionId: string }).connectionId,
      );
      services.registry.getConnection(connectionId);
      const body = parseSchema(confirmedDestructionSchema, request.body);
      services.connections.purge({
        connectionId,
        expectedRevision: body.expectedRevision,
        traceId: request.id,
      });
      return reply.code(204).send();
    },
  );
  app.post(
    "/provider-connection-revisions/:revisionId/discover",
    { schema: { response: { 200: discoveryResponseSchema } } },
    async (request) => {
      const revisionId = (request.params as { revisionId: string }).revisionId as
        ProviderConnectionRevisionId;
      const body = parseSchema(discoverModelsSchema, request.body);
      const connection = findRevisionOwner(services.registry, revisionId);
      if (connection.recordRevision !== body.expectedRevision) {
        throw new ApplicationError("revision_conflict", 409);
      }
      const result = await services.discovery.execute({
        revisionId,
        refresh: true,
        traceId: request.id,
        now: services.now?.() ?? new Date(),
      }, new AbortController().signal);
      return discoveryResponse(result, body.expectedRevision + 1);
    },
  );
  app.get(
    "/provider-connection-revisions/:revisionId/models",
    { schema: { response: { 200: discoveryResponseSchema } } },
    async (request) => {
      const revisionId = (request.params as { revisionId: string }).revisionId as
        ProviderConnectionRevisionId;
      const connection = findRevisionOwner(services.registry, revisionId);
      return discoveryResponse(services.registry.getDiscoveredModels(
        revisionId,
        services.now?.() ?? new Date(),
      ), connection.recordRevision);
    },
  );
}

function credentialInput(
  auth: z.infer<typeof createProviderConnectionSchema>["auth"],
): ProviderCredentialInput {
  switch (auth.type) {
    case "none":
    case "api_key":
      return { type: "none" };
    case "environment":
      return { type: "environment", fromEnvironment: auth.fromEnvironment };
    case "managed_secret":
      return {
        type: "managed_secret",
        managedSecretVersionId: auth.secretVersionId as ManagedSecretVersionId,
      };
  }
}

function credentialSupport(
  auth: z.infer<typeof createProviderConnectionSchema>["auth"],
): "bearer" | "none" {
  return auth.type === "none" ? "none" : "bearer";
}

export function connectionResponse(connection: ProviderConnectionView) {
  const effective = connection.revisions.at(-1);
  const credential = effective === undefined ? noCredential() : credentialMetadata(effective.auth);
  return {
    connectionId: connection.connectionId,
    displayName: connection.displayName,
    providerKind: connection.providerKind,
    ...(connection.providerDriver === undefined
      ? {}
      : { providerDriver: connection.providerDriver }),
    activeRevisionId: connection.activeRevisionId,
    retiredAt: connection.retiredAt?.toISOString() ?? null,
    recordRevision: connection.recordRevision,
    ...credential,
    revisions: connection.revisions.map(connectionRevisionResponse),
  };
}

function connectionRevisionResponse(revision: ProviderConnectionRevision) {
  return {
    revisionId: revision.revisionId,
    connectionId: revision.connectionId,
    state: revision.state,
    baseUrl: revision.baseUrl,
    allowInsecureHttp: revision.allowInsecureHttp,
    protocolPreference: revision.protocolPreference,
    presetVersion: revision.presetVersion,
    ...credentialMetadata(revision.auth),
    createdAt: revision.createdAt.toISOString(),
  };
}

function credentialMetadata(auth: ProviderAuth) {
  if (auth.type === "none") return noCredential();
  if ("managedSecretVersionId" in auth.secret) {
    return {
      credentialConfigured: true as const,
      secretVersionId: auth.secret.managedSecretVersionId,
    };
  }
  return { credentialConfigured: true as const };
}

function noCredential() {
  return { credentialConfigured: false as const };
}

function findRevisionOwner(
  registry: Pick<ModelRegistryStore, "listConnections">,
  revisionId: ProviderConnectionRevisionId,
) {
  const connection = registry.listConnections().find(({ revisions }) =>
    revisions.some((revision) => revision.revisionId === revisionId));
  if (connection === undefined) throw new Error("provider_connection_revision_not_found");
  return connection;
}

function discoveryResponse(view: DiscoveryView, recordRevision: number) {
  return {
    connectionRevisionId: view.connectionRevisionId,
    recordRevision,
    state: view.state,
    models: view.models.map((model) => ({
      id: model.id,
      ...(model.owner === undefined ? {} : { owner: model.owner }),
      ...(model.createdAt === undefined
        ? {}
        : { createdAt: model.createdAt.toISOString() }),
    })),
    cache: {
      fetchedAt: view.fetchedAt?.toISOString() ?? null,
      expiresAt: view.expiresAt?.toISOString() ?? null,
    },
    error: view.refreshError ?? null,
  };
}

function createConnectionOrConflict(
  services: {
    readonly registry: Pick<ModelRegistryStore, "listConnections">;
  },
  connectionId: ProviderConnectionView["connectionId"],
  create: () => ProviderConnectionView,
): ProviderConnectionView {
  try {
    return create();
  } catch (error) {
    if (services.registry.listConnections().some(
      (connection) => connection.connectionId === connectionId,
    )) {
      throw new ApplicationError("resource_conflict", 409);
    }
    throw error;
  }
}
