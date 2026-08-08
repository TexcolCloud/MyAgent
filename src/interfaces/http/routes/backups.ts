import type { FastifyInstance } from "fastify";

import type { CreateBackupService } from "../../../application/create-backup.js";
import { backupRequestSchema, backupResponseSchema, parseSchema } from "../schemas.js";

export function registerBackupRoutes(app: FastifyInstance, backups: CreateBackupService): void {
  app.post("/backups", { schema: { response: { 201: backupResponseSchema } } }, async (request, reply) => {
    const body = parseSchema(backupRequestSchema, request.body);
    const result = await backups.execute(body);
    return reply.code(201).send(result);
  });
}
