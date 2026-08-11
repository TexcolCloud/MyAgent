import type { FastifyInstance } from "fastify";

import type { AssignModelService } from "../../../application/assign-model.js";
import {
  parseAgentId,
  parseModelProfileId,
  type ModelProfileRevisionId,
} from "../../../domain/ids.js";
import type { ModelAssignment } from "../../../domain/model-assignment.js";
import type { DefaultModelProfile } from "../../../domain/model-assignment.js";
import type { ModelRegistryStore } from "../../../ports/model-registry-store.js";
import {
  defaultModelProfileResponseSchema,
  modelAssignmentResponseSchema,
  putDefaultModelProfileSchema,
  putModelAssignmentSchema,
} from "../model-control-schemas.js";
import { parseSchema } from "../schemas.js";

export function registerModelAssignmentRoutes(
  app: FastifyInstance,
  services: {
    readonly registry: Pick<ModelRegistryStore, "getAssignment" | "getDefaultProfile">;
    readonly assignments: Pick<AssignModelService, "assign" | "setDefault">;
  },
): void {
  app.get(
    "/agents/:agentId/model-assignment",
    { schema: { response: { 200: modelAssignmentResponseSchema } } },
    async (request) => {
      const agentId = parseAgentId((request.params as { agentId: string }).agentId);
      return assignmentResponse(agentId, services.registry.getAssignment(agentId));
    },
  );
  app.put(
    "/agents/:agentId/model-assignment",
    { schema: { response: { 200: modelAssignmentResponseSchema } } },
    async (request) => {
      const agentId = parseAgentId((request.params as { agentId: string }).agentId);
      const body = parseSchema(putModelAssignmentSchema, request.body);
      return assignmentResponse(agentId, services.assignments.assign({
        agentId,
        profileRevisionId: body.modelProfileRevisionId as ModelProfileRevisionId,
        expectedRevision: body.expectedRevision,
        traceId: request.id,
      }));
    },
  );
  app.get(
    "/default-model-profile",
    { schema: { response: { 200: defaultModelProfileResponseSchema } } },
    async () => defaultResponse(services.registry.getDefaultProfile()),
  );
  app.put(
    "/default-model-profile",
    { schema: { response: { 200: defaultModelProfileResponseSchema } } },
    async (request) => {
      const body = parseSchema(putDefaultModelProfileSchema, request.body);
      return defaultResponse(services.assignments.setDefault({
        profileId: parseModelProfileId(body.profileId),
        expectedRevision: body.expectedRevision,
        traceId: request.id,
      }));
    },
  );
}

function assignmentResponse(
  agentId: ModelAssignment["agentId"],
  assignment: ModelAssignment | null,
) {
  return assignment === null
    ? {
        agentId,
        state: "unassigned" as const,
        modelProfileRevisionId: null,
        source: null,
        recordRevision: null,
        updatedAt: null,
      }
    : {
        agentId: assignment.agentId,
        state: "assigned" as const,
        modelProfileRevisionId: assignment.modelProfileRevisionId,
        source: assignment.source,
        recordRevision: assignment.recordRevision,
        updatedAt: assignment.updatedAt.toISOString(),
      };
}

function defaultResponse(value: DefaultModelProfile | null) {
  return value === null
    ? { state: "unset" as const, profileId: null, recordRevision: null }
    : {
        state: "configured" as const,
        profileId: value.profileId,
        recordRevision: value.recordRevision,
      };
}
