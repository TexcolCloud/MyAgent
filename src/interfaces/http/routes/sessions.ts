import type { FastifyInstance } from "fastify";

import type { DeleteSessionService } from "../../../application/delete-session.js";
import type { SessionLookupStore } from "../../../ports/session-store.js";
import type { SessionId } from "../../../domain/ids.js";
import { agentIdSchema, identifierSchema, parseSchema, sessionHistoryQuerySchema, sessionKeySchema } from "../schemas.js";

export function registerSessionRoutes(app: FastifyInstance, services: { sessions: SessionLookupStore; deleteSession: DeleteSessionService }): void {
  app.get("/sessions", async (request) => {
    const query = request.query as { agentId?: unknown; sessionKey?: unknown };
    if (query.agentId === undefined || query.sessionKey === undefined) {
      const history = parseSchema(sessionHistoryQuerySchema, request.query);
      const page = services.sessions.listHistory({
        ...(history.agentId === undefined ? {} : { agentId: history.agentId }),
        ...(history.sessionKey === undefined ? {} : { sessionKey: history.sessionKey }),
        limit: history.limit ?? 50,
        ...(history.cursor === undefined ? {} : { cursor: decodeCursor(history.cursor) }),
      });
      return { items: page.items.map(view), ...(page.nextCursor === undefined ? {} : { nextCursor: encodeCursor(page.nextCursor) }) };
    }
    const session = services.sessions.findByIdentity(parseSchema(agentIdSchema, query.agentId), parseSchema(sessionKeySchema, query.sessionKey));
    return { sessions: session === null ? [] : [{ sessionId: session.sessionId, agentId: session.agentId, sessionKey: session.sessionKey, createdAt: session.createdAt.toISOString(), updatedAt: session.updatedAt.toISOString() }] };
  });
  app.delete("/sessions/:sessionId", async (request, reply) => {
    services.deleteSession.execute(parseSchema(identifierSchema, (request.params as { sessionId: unknown }).sessionId) as SessionId);
    return reply.code(204).send();
  });
}

function view(session: { readonly sessionId: SessionId; readonly agentId: string; readonly sessionKey: string; readonly createdAt: Date; readonly updatedAt: Date }) { return { sessionId: session.sessionId, agentId: session.agentId, sessionKey: session.sessionKey, createdAt: session.createdAt.toISOString(), updatedAt: session.updatedAt.toISOString() }; }
function encodeCursor(cursor: { readonly updatedAt: Date; readonly sessionId: SessionId }): string { return Buffer.from(JSON.stringify({ updatedAt: cursor.updatedAt.toISOString(), sessionId: cursor.sessionId })).toString("base64url"); }
function decodeCursor(cursor: string): { readonly updatedAt: Date; readonly sessionId: SessionId } { try { const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { updatedAt?: unknown; sessionId?: unknown }; if (typeof value.updatedAt !== "string" || typeof value.sessionId !== "string") throw new Error(); const updatedAt = new Date(value.updatedAt); if (!Number.isFinite(updatedAt.getTime())) throw new Error(); return { updatedAt, sessionId: value.sessionId as SessionId }; } catch { throw new Error("invalid_request"); } }
