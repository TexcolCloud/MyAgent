import type { FastifyInstance } from "fastify";

import type { CancelRunService } from "../../../application/cancel-run.js";
import type { CreateRunService } from "../../../application/create-run.js";
import type { RunStore } from "../../../ports/run-store.js";
import type { RunId } from "../../../domain/ids.js";
import { activeRunsQuerySchema, activeRunsResponseSchema, createRunResponseSchema, createRunSchema, idempotencyKeySchema, identifierSchema, parseSchema, runResponseSchema } from "../schemas.js";
import { parseLastEventId, streamRunEvents, type SseStreamOptions } from "../sse.js";

export function registerRunRoutes(app: FastifyInstance, services: {
  createRuns: CreateRunService;
  runs: Pick<RunStore, "getRun" | "listActiveRuns" | "listEventsAfter">;
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
  app.get("/runs", { schema: { response: { 200: activeRunsResponseSchema } } }, async (request) => {
    parseSchema(activeRunsQuerySchema, request.query);
    return { runs: services.runs.listActiveRuns() };
  });
  app.get("/runs/:runId", { schema: { response: { 200: runResponseSchema } } }, async (request) => runView(services.runs.getRun(parseSchema(identifierSchema, (request.params as { runId: unknown }).runId) as RunId)));
  app.post("/runs/:runId/cancel", { schema: { response: { 200: runResponseSchema } } }, async (request) => runView(services.cancelRuns.execute({ runId: parseSchema(identifierSchema, (request.params as { runId: unknown }).runId) as RunId }) as ReturnType<RunStore["getRun"]>));
  app.get("/runs/:runId/events", async (request, reply) => {
    const runId = parseSchema(identifierSchema, (request.params as { runId: unknown }).runId) as RunId;
    services.runs.getRun(runId);
    parseLastEventId(request.headers["last-event-id"]);
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
    await streamRunEvents(request, reply.raw, runId, services.runs, services.sse);
  });
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
