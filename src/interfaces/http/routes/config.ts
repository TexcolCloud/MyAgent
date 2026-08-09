import type { FastifyInstance } from "fastify";

import type { CatalogSnapshot } from "../../../config/catalog-loader.js";
import type { CatalogService } from "../../../config/catalog-service.js";
import { configReloadResponseSchema } from "../schemas.js";

export function registerConfigRoutes(app: FastifyInstance, catalog: CatalogService): void {
  app.post("/config/reload", { schema: { response: { 200: configReloadResponseSchema } } }, async () => {
    return catalog.reload(configReloadResponse);
  });
}

function configReloadResponse(snapshot: CatalogSnapshot) {
  return configReloadResponseSchema.parse({
    agents: snapshot.available.map((agent) => ({
      id: agent.id,
      revisionId: agent.definition.definitionRevisionId,
    })),
    unavailable: snapshot.unavailable.map((agent) => ({
      label: agent.sourceLabel,
      code: agent.code,
    })),
  });
}
