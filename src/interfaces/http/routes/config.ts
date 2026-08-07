import type { FastifyInstance } from "fastify";

import type { CatalogService } from "../../../config/catalog-service.js";

export function registerConfigRoutes(app: FastifyInstance, catalog: CatalogService): void {
  app.post("/config/reload", async () => {
    const snapshot = await catalog.reload();
    return { agents: snapshot.available.map((agent) => ({ id: agent.id, revisionId: agent.revision.revisionId })), unavailable: snapshot.unavailable.map((agent) => ({ id: agent.id, code: agent.code })) };
  });
}
