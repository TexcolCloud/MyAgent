import { randomUUID } from "node:crypto";

import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from "fastify";

import type { CancelRunService } from "../../application/cancel-run.js";
import type { AssignModelService } from "../../application/assign-model.js";
import type { CreateBackupService } from "../../application/create-backup.js";
import type { CreateManagedAgentService } from "../../application/create-managed-agent.js";
import type { CreateRunService } from "../../application/create-run.js";
import type { DecideApprovalService } from "../../application/decide-approval.js";
import type { DeleteSessionService } from "../../application/delete-session.js";
import type { DiscoverModelsService } from "../../application/discover-models.js";
import { ListProviderDriversService } from "../../application/list-provider-drivers.js";
import type { ManageModelProfilesService } from "../../application/manage-model-profiles.js";
import type { ManageProviderConnectionsService } from "../../application/manage-provider-connections.js";
import type { ManageSecretsService } from "../../application/manage-secrets.js";
import type { ReconcileToolCallService } from "../../application/reconcile-tool-call.js";
import type { VerifyModelService } from "../../application/verify-model.js";
import type { CatalogSnapshot } from "../../config/catalog-loader.js";
import type { CatalogService } from "../../config/catalog-service.js";
import type { ApprovalStore } from "../../ports/approval-store.js";
import type { ModelRegistryStore } from "../../ports/model-registry-store.js";
import type { RunStore } from "../../ports/run-store.js";
import type { SessionLookupStore } from "../../ports/session-store.js";
import type { ReconciliationStore } from "../../ports/tool-store.js";
import { isAuthorized, isLoopbackPeer, tokensEqual } from "./auth.js";
import { sendError, sendProblem } from "./problem.js";
import { registerHealthRoutes, type ReadinessProbe } from "./routes/health.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerBackupRoutes } from "./routes/backups.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerToolCallRoutes } from "./routes/tool-calls.js";
import { registerProviderConnectionRoutes } from "./routes/provider-connections.js";
import { registerModelProfileRoutes } from "./routes/model-profiles.js";
import { registerModelVerificationRoutes } from "./routes/model-verifications.js";
import { registerModelAssignmentRoutes } from "./routes/model-assignments.js";
import { registerManagedSecretRoutes } from "./routes/managed-secrets.js";
import { registerManagedAgentRoutes } from "./routes/managed-agents.js";
import { registerProviderDriverRoutes } from "./routes/provider-drivers.js";
import { serializeWithSchema } from "./schemas.js";
import type { SseStreamOptions } from "./sse.js";

export interface ModelControlServices {
  readonly registry: ModelRegistryStore;
  readonly connections: ManageProviderConnectionsService;
  readonly profiles: ManageModelProfilesService;
  readonly secrets: ManageSecretsService;
  readonly assignments: AssignModelService;
  readonly discovery: DiscoverModelsService;
  readonly verifications: VerifyModelService;
  readonly now?: () => Date;
}

export interface HttpAppOptions {
  bearerToken: string;
  adminToken?: string;
  modelControl?: ModelControlServices;
  catalog?: CatalogService;
  prepareCatalogReload?: (candidate: CatalogSnapshot) => void;
  createRuns?: CreateRunService;
  runs?: Pick<RunStore, "getRun" | "listActiveRuns" | "listEventsAfter">;
  cancelRuns?: CancelRunService;
  approvals?: Pick<ApprovalStore, "listPending">;
  decideApprovals?: DecideApprovalService;
  tools?: Pick<ReconciliationStore, "get">;
  reconcileTools?: ReconcileToolCallService;
  sessions?: SessionLookupStore;
  deleteSession?: DeleteSessionService;
  sse?: SseStreamOptions;
  createBackups?: CreateBackupService;
  createManagedAgents?: CreateManagedAgentService;
  logger?: FastifyBaseLogger;
  readiness?: ReadinessProbe;
}

export function createHttpApp(options: HttpAppOptions): FastifyInstance {
  if (options.bearerToken.length === 0) {
    throw new Error("http_bearer_token_required");
  }
  if (options.adminToken !== undefined && tokensEqual(options.bearerToken, options.adminToken)) {
    throw new Error("http_admin_token_must_differ");
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
    const requestPath = request.url.split("?", 1)[0]!;
    const authorization = typeof request.headers.authorization === "string"
      ? request.headers.authorization
      : undefined;
    if (requestPath === "/v1/admin" || requestPath.startsWith("/v1/admin/")) {
      if (options.adminToken === undefined || !isAuthorized(authorization, options.adminToken)) {
        request.log.warn({ code: "unauthorized" }, "HTTP request authentication failed");
        return sendProblem(reply, request, 401, "unauthorized", "Authentication is required.");
      }
      if (!isLoopbackPeer(request.raw.socket.remoteAddress)) {
        return sendProblem(reply, request, 403, "forbidden", "Access is forbidden.");
      }
      return;
    }
    if (requestPath === "/v1" || requestPath.startsWith("/v1/")) {
      if (!isAuthorized(authorization, options.bearerToken)) {
        request.log.warn({ code: "unauthorized" }, "HTTP request authentication failed");
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
    app.register((api, _routeOptions, done) => {
      registerAgentRoutes(api, options.catalog!);
      registerConfigRoutes(
        api,
        options.catalog!,
        options.prepareCatalogReload,
      );
      done();
    }, { prefix: "/v1" });
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
  if (options.modelControl !== undefined) {
    app.register((api, _routeOptions, done) => {
      const providerDrivers = new ListProviderDriversService();
      registerProviderDriverRoutes(api, providerDrivers);
      registerProviderConnectionRoutes(api, {
        ...options.modelControl!,
        providerDrivers,
      });
      registerModelProfileRoutes(api, {
        ...options.modelControl!,
        providerDrivers,
      });
      registerModelVerificationRoutes(api, options.modelControl!);
      registerModelAssignmentRoutes(api, options.modelControl!);
      registerManagedSecretRoutes(api, options.modelControl!);
      done();
    }, { prefix: "/v1/admin" });
  }
  if (options.createManagedAgents !== undefined) {
    app.register((api, _routeOptions, done) => {
      registerManagedAgentRoutes(api, options.createManagedAgents!);
      done();
    }, { prefix: "/v1/admin" });
  }
  app.setErrorHandler((error, request, reply) => sendError(error, request, reply));
  app.setNotFoundHandler((request, reply) =>
    sendProblem(reply, request, 404, "not_found", "The requested resource does not exist."));
  return app;
}
