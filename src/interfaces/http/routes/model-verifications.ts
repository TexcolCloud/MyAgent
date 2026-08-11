import type { FastifyInstance } from "fastify";

import type { VerifyModelService } from "../../../application/verify-model.js";
import type {
  ModelProfileId,
  ModelProfileRevisionId,
  ModelVerificationId,
} from "../../../domain/ids.js";
import type { ModelVerification } from "../../../domain/model-verification.js";
import type { ModelRegistryStore } from "../../../ports/model-registry-store.js";
import {
  expectedRevisionSchema,
  modelVerificationResponseSchema,
  queuedModelVerificationResponseSchema,
  queueModelVerificationSchema,
} from "../model-control-schemas.js";
import { parseSchema } from "../schemas.js";

export function registerModelVerificationRoutes(
  app: FastifyInstance,
  services: {
    readonly registry: Pick<ModelRegistryStore, "getVerification" | "listProfiles">;
    readonly verifications: Pick<VerifyModelService, "cancel" | "queue">;
  },
): void {
  app.post(
    "/model-profile-revisions/:revisionId/verifications",
    { schema: { response: { 202: queuedModelVerificationResponseSchema } } },
    async (request, reply) => {
      const revisionId = (request.params as { revisionId: string }).revisionId as
        ModelProfileRevisionId;
      const body = parseSchema(queueModelVerificationSchema, request.body);
      const profileId = findProfileOwner(services.registry, revisionId);
      const verification = services.verifications.queue({
        profileId,
        profileRevisionId: revisionId,
        expectedRevision: body.expectedRevision,
        traceId: request.id,
      });
      return reply.code(202).send({
        verificationId: verification.verificationId,
        profileRevisionId: verification.profileRevisionId,
        capabilityBaseline: verification.capabilityBaseline,
        status: verification.state,
        recordRevision: verification.recordRevision,
        operationUrl: `/v1/admin/model-verifications/${verification.verificationId}`,
      });
    },
  );
  app.get(
    "/model-verifications/:verificationId",
    { schema: { response: { 200: modelVerificationResponseSchema } } },
    async (request) => verificationResponse(
      services.registry,
      services.registry.getVerification(
        (request.params as { verificationId: string }).verificationId as
          ModelVerificationId,
      ),
    ),
  );
  app.post(
    "/model-verifications/:verificationId/cancel",
    { schema: { response: { 200: modelVerificationResponseSchema } } },
    async (request) => {
      const verificationId =
        (request.params as { verificationId: string }).verificationId as
          ModelVerificationId;
      const body = parseSchema(expectedRevisionSchema, request.body);
      return verificationResponse(
        services.registry,
        services.verifications.cancel({
          verificationId,
          expectedRevision: body.expectedRevision,
          traceId: request.id,
        }),
      );
    },
  );
}

function findProfileOwner(
  registry: Pick<ModelRegistryStore, "listProfiles">,
  revisionId: ModelProfileRevisionId,
): ModelProfileId {
  const profile = registry.listProfiles().find(({ revisions }) =>
    revisions.some((revision) => revision.revisionId === revisionId));
  if (profile === undefined) throw new Error("model_profile_revision_not_found");
  return profile.profileId;
}

function verificationResponse(
  registry: Pick<ModelRegistryStore, "getVerification">,
  verification: ModelVerification,
) {
  const fallback = verification.fallbackVerificationId === null
    ? null
    : registry.getVerification(verification.fallbackVerificationId);
  return {
    verificationId: verification.verificationId,
    profileRevisionId: verification.profileRevisionId,
    capabilityBaseline: verification.capabilityBaseline,
    status: verification.state,
    resultCode: verification.resultCode ?? null,
    safeStatus: verification.safeStatus ?? null,
    capabilities: verification.capabilities,
    ...(verification.usage === undefined ? {} : { usage: verification.usage }),
    traceId: verification.traceId,
    recordRevision: verification.recordRevision,
    createdAt: verification.createdAt.toISOString(),
    updatedAt: verification.updatedAt.toISOString(),
    cancellationRequestedAt:
      verification.cancellationRequestedAt?.toISOString() ?? null,
    fallbackProfileRevisionId: fallback?.profileRevisionId ?? null,
    fallbackVerificationId: verification.fallbackVerificationId,
  };
}
