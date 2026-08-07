import type { FastifyInstance } from "fastify";

import type { CatalogService } from "../../../config/catalog-service.js";
import { configReloadResponseSchema } from "../schemas.js";

export function registerConfigRoutes(app: FastifyInstance, catalog: CatalogService): void {
  app.post("/config/reload", { schema: { response: { 200: configReloadResponseSchema } } }, async () => {
    const snapshot = await catalog.reload();
    return { agents: snapshot.available.map((agent) => ({ id: agent.id, revisionId: agent.revision.revisionId })), unavailable: snapshot.unavailable.map((agent) => ({ id: agent.id, code: agent.code })) };
  });
}
