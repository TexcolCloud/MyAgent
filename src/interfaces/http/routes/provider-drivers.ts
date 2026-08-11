import type { FastifyInstance } from "fastify";

import type { ListProviderDriversService } from "../../../application/list-provider-drivers.js";
import { providerDriversResponseSchema } from "../model-control-schemas.js";

export function registerProviderDriverRoutes(
  app: FastifyInstance,
  providerDrivers: ListProviderDriversService,
): void {
  app.get(
    "/provider-drivers",
    { schema: { response: { 200: providerDriversResponseSchema } } },
    async () => providerDrivers.list(),
  );
}
