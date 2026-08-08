import { randomUUID } from "node:crypto";

import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from "fastify";

import type { CancelRunService } from "../../application/cancel-run.js";
import type { CreateBackupService } from "../../application/create-backup.js";
import type { CreateRunService } from "../../application/create-run.js";
import type { DecideApprovalService } from "../../application/decide-approval.js";
import type { DeleteSessionService } from "../../application/delete-session.js";
import type { ReconcileToolCallService } from "../../application/reconcile-tool-call.js";
import type { CatalogService } from "../../config/catalog-service.js";
import type { ApprovalStore } from "../../ports/approval-store.js";
import type { RunStore } from "../../ports/run-store.js";
import type { SessionLookupStore } from "../../ports/session-store.js";
import type { ReconciliationStore } from "../../ports/tool-store.js";
import { isAuthorized } from "./auth.js";
import { sendError, sendProblem } from "./problem.js";
import { registerHealthRoutes, type ReadinessProbe } from "./routes/health.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerBackupRoutes } from "./routes/backups.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerToolCallRoutes } from "./routes/tool-calls.js";
import { serializeWithSchema } from "./schemas.js";
import type { SseStreamOptions } from "./sse.js";

export interface HttpAppOptions {
  bearerToken: string;
  catalog?: CatalogService;
  createRuns?: CreateRunService;
  runs?: Pick<RunStore, "getRun" | "listEventsAfter">;
  cancelRuns?: CancelRunService;
  approvals?: Pick<ApprovalStore, "listPending">;
  decideApprovals?: DecideApprovalService;
  tools?: Pick<ReconciliationStore, "get">;
  reconcileTools?: ReconcileToolCallService;
  sessions?: SessionLookupStore;
  deleteSession?: DeleteSessionService;
  sse?: SseStreamOptions;
  createBackups?: CreateBackupService;
  logger?: FastifyBaseLogger;
  readiness?: ReadinessProbe;
}

export function createHttpApp(options: HttpAppOptions): FastifyInstance {
  if (options.bearerToken.length === 0) {
    throw new Error("http_bearer_token_required");
  }

  const app = Fastify({
    genReqId: () => randomUUID(),
    ...(options.logger === undefined
      ? { logger: false as const }
      : {
          loggerInstance: options.logger,
          logController: new LogController({
            disableRequestLogging: true,
            requestIdLogLabel: "traceId",
          }),
        }),
  });
  app.setSerializerCompiler(({ schema }) => serializeWithSchema(schema));
  registerHealthRoutes(app, options.readiness ?? (() => true));
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/v1" || request.url.startsWith("/v1/")) {
      const authorization = request.headers.authorization;
      if (!isAuthorized(
        typeof authorization === "string" ? authorization : undefined,
        options.bearerToken,
      )) {
        return sendProblem(reply, request, 401, "unauthorized", "Authentication is required.");
      }
    }
  });
  if (options.createRuns !== undefined && options.runs !== undefined && options.cancelRuns !== undefined) {
    app.register((api, _routeOptions, done) => {
      registerRunRoutes(api, {
        createRuns: options.createRuns!,
        runs: options.runs!,
        cancelRuns: options.cancelRuns!,
        ...(options.sse === undefined ? {} : { sse: options.sse }),
      });
      done();
    }, { prefix: "/v1" });
  }
  if (options.catalog !== undefined) {
    app.register((api, _routeOptions, done) => { registerAgentRoutes(api, options.catalog!); registerConfigRoutes(api, options.catalog!); done(); }, { prefix: "/v1" });
  }
  if (options.approvals !== undefined && options.decideApprovals !== undefined && options.tools !== undefined) {
    app.register((api, _routeOptions, done) => { registerApprovalRoutes(api, { approvals: options.approvals!, decideApprovals: options.decideApprovals!, tools: options.tools! }); done(); }, { prefix: "/v1" });
  }
  if (options.reconcileTools !== undefined) {
    app.register((api, _routeOptions, done) => { registerToolCallRoutes(api, options.reconcileTools!); done(); }, { prefix: "/v1" });
  }
  if (options.sessions !== undefined && options.deleteSession !== undefined) {
    app.register((api, _routeOptions, done) => { registerSessionRoutes(api, { sessions: options.sessions!, deleteSession: options.deleteSession! }); done(); }, { prefix: "/v1" });
  }
  if (options.createBackups !== undefined) {
    app.register((api, _routeOptions, done) => { registerBackupRoutes(api, options.createBackups!); done(); }, { prefix: "/v1" });
  }
  app.setErrorHandler((error, request, reply) => sendError(error, request, reply));
  app.setNotFoundHandler((request, reply) =>
    sendProblem(reply, request, 404, "not_found", "The requested resource does not exist."));
  return app;
}
