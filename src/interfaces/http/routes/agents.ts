import type { FastifyInstance } from "fastify";

import type { CatalogService } from "../../../config/catalog-service.js";

export function registerAgentRoutes(app: FastifyInstance, catalog: CatalogService): void {
  app.get("/agents", async () => ({
    agents: catalog.current().available.map((agent) => ({ id: agent.id, revisionId: agent.revision.revisionId, displayName: agent.revision.displayName })),
    unavailable: catalog.current().unavailable.map((agent) => ({ id: agent.id, code: agent.code })),
  }));
}
