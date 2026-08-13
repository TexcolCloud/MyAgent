import type { FastifyInstance } from "fastify";

import type { DiagnosticReport } from "../../../application/collect-diagnostics.js";
import { diagnosticsResponseSchema, healthResponseSchema, readinessResponseSchema } from "../schemas.js";

export type ReadinessProbe = () => boolean | Promise<boolean>;

export function registerHealthRoutes(
  app: FastifyInstance,
  readiness: ReadinessProbe,
): void {
  app.get("/healthz", { schema: { response: { 200: healthResponseSchema } } }, async () => ({ ok: true }));
  app.get("/readyz", {
    schema: { response: { 200: readinessResponseSchema, 503: readinessResponseSchema } },
  }, async (_request, reply) => {
    let ready = false;
    try {
      ready = await readiness();
    } catch {
      ready = false;
    }
    return reply.code(ready ? 200 : 503).send({ ready });
  });
}

export function registerDiagnosticRoutes(
  app: FastifyInstance,
  diagnostics: () => Promise<DiagnosticReport>,
): void {
  app.get("/diagnostics", { schema: { response: { 200: diagnosticsResponseSchema } } }, diagnostics);
}
