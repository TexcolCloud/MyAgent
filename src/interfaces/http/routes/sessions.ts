import type { FastifyInstance } from "fastify";

import type { DeleteSessionService } from "../../../application/delete-session.js";
import type { SessionLookupStore } from "../../../ports/session-store.js";
import type { SessionId } from "../../../domain/ids.js";
import { agentIdSchema, identifierSchema, parseSchema, sessionKeySchema, sessionsResponseSchema } from "../schemas.js";

export function registerSessionRoutes(app: FastifyInstance, services: { sessions: SessionLookupStore; deleteSession: DeleteSessionService }): void {
  app.get("/sessions", { schema: { response: { 200: sessionsResponseSchema } } }, async (request) => {
    const query = request.query as { agentId?: unknown; sessionKey?: unknown };
    const session = services.sessions.findByIdentity(parseSchema(agentIdSchema, query.agentId), parseSchema(sessionKeySchema, query.sessionKey));
    return { sessions: session === null ? [] : [{ sessionId: session.sessionId, agentId: session.agentId, sessionKey: session.sessionKey, createdAt: session.createdAt.toISOString(), updatedAt: session.updatedAt.toISOString() }] };
  });
  app.delete("/sessions/:sessionId", async (request, reply) => {
    services.deleteSession.execute(parseSchema(identifierSchema, (request.params as { sessionId: unknown }).sessionId) as SessionId);
    return reply.code(204).send();
  });
}
