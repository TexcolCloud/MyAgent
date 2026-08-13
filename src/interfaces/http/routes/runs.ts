import type { FastifyInstance } from "fastify";

import type { CancelRunService } from "../../../application/cancel-run.js";
import type { CreateRunService } from "../../../application/create-run.js";
import type { RunStore } from "../../../ports/run-store.js";
import type { AgentId, RunId, SessionKey } from "../../../domain/ids.js";
import { activeRunsQuerySchema, cancelRunSchema, createRunResponseSchema, createRunSchema, idempotencyKeySchema, identifierSchema, parseSchema, runHistoryQuerySchema, runResponseSchema } from "../schemas.js";
import { parseLastEventId, streamRunEvents, type SseStreamOptions } from "../sse.js";

export function registerRunRoutes(app: FastifyInstance, services: {
  createRuns: CreateRunService;
  runs: Pick<RunStore, "getRun" | "listActiveRuns" | "listHistory" | "listEventsAfter">;
  cancelRuns: CancelRunService;
  sse?: SseStreamOptions;
}): void {
  app.post("/runs", { schema: { response: { 202: createRunResponseSchema } } }, async (request, reply) => {
    const body = parseSchema(createRunSchema, request.body);
    const key = parseSchema(idempotencyKeySchema, request.headers["idempotency-key"]);
    const source = body.source?.externalId === undefined ? { kind: "http" as const } : { kind: "http" as const, externalId: body.source.externalId };
    const result = services.createRuns.execute({ ...body, idempotencyKey: key, source });
    return reply.code(202).send({ runId: result.runId, status: result.state, eventsUrl: `/v1/runs/${result.runId}/events` });
  });
  app.get("/runs", async (request) => {
    const query = request.query as { state?: unknown };
    if (query.state !== undefined) {
      parseSchema(activeRunsQuerySchema, request.query);
      return { runs: services.runs.listActiveRuns() };
    }
    const history = parseSchema(runHistoryQuerySchema, request.query);
    const page = services.runs.listHistory({
      agentId: history.agentId as AgentId,
      sessionKey: history.sessionKey as SessionKey,
      limit: history.limit ?? 50,
      ...(history.cursor === undefined ? {} : { cursor: decodeCursor(history.cursor) }),
    });
    return {
      items: page.items.map(runView),
      ...(page.nextCursor === undefined ? {} : { nextCursor: encodeCursor(page.nextCursor) }),
    };
  });
  app.get("/runs/:runId", { schema: { response: { 200: runResponseSchema } } }, async (request) => runView(services.runs.getRun(parseSchema(identifierSchema, (request.params as { runId: unknown }).runId) as RunId)));
  app.post("/runs/:runId/cancel", { schema: { response: { 200: runResponseSchema } } }, async (request) => {
    const body = parseSchema(cancelRunSchema, request.body);
    return runView(services.cancelRuns.execute({ runId: parseSchema(identifierSchema, (request.params as { runId: unknown }).runId) as RunId, expectedRevision: body.expectedRevision }) as ReturnType<RunStore["getRun"]>);
  });
  app.get("/runs/:runId/events", async (request, reply) => {
    const runId = parseSchema(identifierSchema, (request.params as { runId: unknown }).runId) as RunId;
    services.runs.getRun(runId);
    parseLastEventId(request.headers["last-event-id"]);
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
    await streamRunEvents(request, reply.raw, runId, services.runs, services.sse);
  });
}

function encodeCursor(cursor: { readonly updatedAt: Date; readonly runId: RunId }): string {
  return Buffer.from(JSON.stringify({ updatedAt: cursor.updatedAt.toISOString(), runId: cursor.runId }))
    .toString("base64url");
}

function decodeCursor(cursor: string): { readonly updatedAt: Date; readonly runId: RunId } {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      updatedAt?: unknown; runId?: unknown;
    };
    if (typeof value.updatedAt !== "string" || typeof value.runId !== "string") throw new Error("invalid_cursor");
    const updatedAt = new Date(value.updatedAt);
    if (!Number.isFinite(updatedAt.getTime())) throw new Error("invalid_cursor");
    return { updatedAt, runId: value.runId as RunId };
  } catch {
    throw new Error("invalid_request");
  }
}

function runView(run: ReturnType<RunStore["getRun"]>) {
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    agentId: run.agentId,
    status: run.state,
    fifoSequence: run.fifoSequence,
    parentRunId: run.parentRunId,
    rootRunId: run.rootRunId,
    delegationDepth: run.delegationDepth,
    budget: run.budget,
    ...(run.state === "completed" ? { result: run.result } : {}),
    ...(run.state === "failed"
      ? { failure: run.failure ?? { code: "run_failed" } }
      : {}),
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}
