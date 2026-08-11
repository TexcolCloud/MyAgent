import type { FastifyInstance } from "fastify";

import type { CatalogSnapshot } from "../../../config/catalog-loader.js";
import type { CatalogService } from "../../../config/catalog-service.js";
import { agentsResponseSchema } from "../schemas.js";

export function registerAgentRoutes(app: FastifyInstance, catalog: CatalogService): void {
  app.get(
    "/agents",
    { schema: { response: { 200: agentsResponseSchema } } },
    async () => agentsResponse(catalog.current()),
  );
}

function agentsResponse(snapshot: CatalogSnapshot) {
  return agentsResponseSchema.parse({
    agents: snapshot.available.map((agent) => ({
      id: agent.id,
      revisionId: agent.definition.definitionRevisionId,
      displayName: agent.definition.displayName,
    })),
    unavailable: snapshot.unavailable.map((agent) => ({
      label: agent.sourceLabel,
      code: agent.code,
    })),
  });
}
