import type { FastifyInstance } from "fastify";

import { healthResponseSchema, readinessResponseSchema } from "../schemas.js";

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/healthz", { schema: { response: { 200: healthResponseSchema } } }, async () => ({ status: "ok" }));
  app.get("/readyz", { schema: { response: { 200: readinessResponseSchema } } }, async () => ({ status: "ready" }));
}
