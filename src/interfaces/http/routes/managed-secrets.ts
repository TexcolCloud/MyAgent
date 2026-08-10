import type { FastifyInstance } from "fastify";

import type { ManageSecretsService } from "../../../application/manage-secrets.js";
import { ApplicationError } from "../../../domain/errors.js";
import type { ManagedSecretVersionId } from "../../../domain/ids.js";
import type { ModelRegistryStore } from "../../../ports/model-registry-store.js";
import {
  confirmedDestructionSchema,
  expectedRevisionSchema,
  masterKeyRotationResponseSchema,
} from "../model-control-schemas.js";
import { parseSchema } from "../schemas.js";

export function registerManagedSecretRoutes(
  app: FastifyInstance,
  services: {
    readonly secrets: Pick<
      ManageSecretsService,
      "destroyVersion" | "rotateMasterKey"
    >;
    readonly registry: Pick<ModelRegistryStore, "inspectSecretReferences">;
  },
): void {
  app.post(
    "/managed-secret-versions/:secretVersionId/destruction",
    async (request, reply) => {
      const versionId =
        (request.params as { secretVersionId: string }).secretVersionId as
          ManagedSecretVersionId;
      const body = parseSchema(confirmedDestructionSchema, request.body);
      const references = services.registry.inspectSecretReferences(versionId);
      if (references.length > 0) {
        throw new ApplicationError("resource_in_use", 409, "resource_in_use", {
          ownerCategories: [...new Set(references.map((reference) => reference.type))],
        });
      }
      services.secrets.destroyVersion({
        versionId,
        expectedRevision: body.expectedRevision,
      });
      return reply.code(204).send();
    },
  );
  app.post(
    "/managed-secrets/master-key-rotation",
    { schema: { response: { 200: masterKeyRotationResponseSchema } } },
    async (request) => {
      const body = parseSchema(expectedRevisionSchema, request.body);
      const result = services.secrets.rotateMasterKey({
        expectedRevision: body.expectedRevision,
      });
      return {
        reencrypted: result.reencrypted,
        currentKeyId: result.currentKeyId,
        recordRevision: result.recordRevision,
      };
    },
  );
}
