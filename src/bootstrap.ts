import { randomUUID } from "node:crypto";
import { mkdir, access } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

import type { DatabaseSync } from "node:sqlite";

import { EnvironmentSecretResolver } from "./adapters/environment-secret-resolver.js";
import { CompositeSecretResolver } from "./adapters/composite-secret-resolver.js";
import { OpenAiChatCompletionsModel } from "./adapters/model/openai-chat-completions.js";
import { OpenAiModelDiscovery } from "./adapters/model/openai-model-discovery.js";
import { OpenAiResponsesModel } from "./adapters/model/openai-responses.js";
import { ModelRuntimeRouter } from "./adapters/model/model-runtime-router.js";
import { PiAiSdkClient } from "./adapters/model/pi-ai-client.js";
import { PiAiModelAdapter } from "./adapters/model/pi-ai-model.js";
import { NodeProviderHttpTransport } from "./adapters/provider-http-transport.js";
import {
  ProviderEgressGateway,
  type ProviderEgressGatewayListen,
} from "./adapters/provider-egress-gateway.js";
import { SqliteApprovalRepository } from "./adapters/sqlite/approval-repository.js";
import { SqliteBackupWriter } from "./adapters/sqlite/backup.js";
import { SqliteCatalogRepository } from "./adapters/sqlite/catalog-repository.js";
import {
  openDatabase,
  withImmediateTransaction,
} from "./adapters/sqlite/database.js";
import { migrate } from "./adapters/sqlite/migrator.js";
import { SqliteRunRepository } from "./adapters/sqlite/run-repository.js";
import { SqliteSessionRepository } from "./adapters/sqlite/session-repository.js";
import { SqliteToolRepository } from "./adapters/sqlite/tool-repository.js";
import { SqliteEncryptedSecretStore } from "./adapters/sqlite/encrypted-secret-store.js";
import { SqliteModelRegistryRepository } from "./adapters/sqlite/model-registry-repository.js";
import { SystemClock } from "./adapters/system-clock.js";
import { activateSkillTool } from "./adapters/tools/activate-skill.js";
import { createDelegateAgentTool } from "./adapters/tools/delegate-agent.js";
import { listFilesTool } from "./adapters/tools/list-files.js";
import { readFileTool } from "./adapters/tools/read-file.js";
import { ToolRegistry } from "./adapters/tools/registry.js";
import { createRunCommandTool } from "./adapters/tools/run-command.js";
import { writeFileTool } from "./adapters/tools/write-file.js";
import { UuidIdGenerator } from "./adapters/uuid-id-generator.js";
import { AdvanceRunService } from "./application/advance-run.js";
import { AgentResolver } from "./application/agent-resolver.js";
import { AssignModelService } from "./application/assign-model.js";
import { CancelRunService } from "./application/cancel-run.js";
import { activeSecretReferencesResolvable, collectDiagnostics, projectStatePermissionsAvailable } from "./application/collect-diagnostics.js";
import { CreateBackupService } from "./application/create-backup.js";
import { CreateManagedAgentService } from "./application/create-managed-agent.js";
import { CreateRunService } from "./application/create-run.js";
import { DecideApprovalService } from "./application/decide-approval.js";
import { DelegateAgentService } from "./application/delegate-agent.js";
import { DeleteSessionService } from "./application/delete-session.js";
import { DiscoverModelsService } from "./application/discover-models.js";
import { ImportLegacyModelsService } from "./application/import-legacy-models.js";
import { ManageModelProfilesService } from "./application/manage-model-profiles.js";
import { ManageProviderConnectionsService } from "./application/manage-provider-connections.js";
import { ManageSecretsService } from "./application/manage-secrets.js";
import { PolicyEngine } from "./application/policy-engine.js";
import { PromptAssembler } from "./application/prompt-assembler.js";
import { ReconcileToolCallService } from "./application/reconcile-tool-call.js";
import { VerifyModelService } from "./application/verify-model.js";
import { loadBootConfig } from "./config/boot-config.js";
import { loadCatalog } from "./config/catalog-loader.js";
import { CatalogService } from "./config/catalog-service.js";
import { createHttpApp } from "./interfaces/http/app.js";
import { createStructuredLogger } from "./observability/logger.js";
import { MutableDynamicRedactionRegistry } from "./observability/redactor.js";
import type { Clock } from "./ports/clock.js";
import type { ModelPort } from "./ports/model.js";
import { assertSupportedRuntime } from "./platform.js";
import { ApprovalExpirer } from "./runtime/approval-expirer.js";
import { ExecutionRegistry } from "./runtime/execution-registry.js";
import { noFaults, type FaultInjector } from "./runtime/fault-injector.js";
import { ModelVerificationWorker } from "./runtime/model-verification-worker.js";
import { RunWorker } from "./runtime/run-worker.js";

export interface BootstrapOptions {
  auth?: {
    readonly bearerToken: string;
    readonly adminToken: string;
  };
  listen?: { host?: string; port?: number };
  projectStateRoot?: string;
  signals?: boolean;
  log?: {
    write?: (line: string) => void;
    sensitiveKeys?: readonly string[];
  };
  faults?: FaultInjector;
  model?: ModelPort;
  clock?: Clock;
  worker?: {
    concurrency?: number;
    leaseDurationMs?: number;
    idleDelayMs?: number;
  };
  providerGateway?: {
    listen?: ProviderEgressGatewayListen;
    onStopped?: () => void | Promise<void>;
  };
}

export interface BootstrappedService {
  url: string;
  shutdown(): Promise<void>;
}

export function resolveBootstrapProjectStateRoot(
  configPath: string,
  projectStateRoot?: string,
): string {
  return path.resolve(projectStateRoot ?? path.dirname(path.resolve(configPath)));
}

const DEFAULT_MODEL_CONTROL = Object.freeze({
  discoveryCacheSeconds: 600,
  discoveryTimeoutMs: 10_000,
  verificationRequestTimeoutMs: 30_000,
  verificationJobTimeoutMs: 120_000,
  maxDiscoveredModels: 1_000,
  maxDiscoveryResponseBytes: 2_097_152,
  verificationConcurrency: 1,
});

export async function bootstrap(
  configPath: string,
  options: BootstrapOptions = {},
): Promise<BootstrappedService> {
  assertSupportedRuntime();
  const injectedAuth = options.auth === undefined ? undefined : Object.freeze({
    bearerToken: options.auth.bearerToken,
    adminToken: options.auth.adminToken,
  });
  if (injectedAuth !== undefined) {
    assertValidHttpAuth(injectedAuth);
    Object.freeze(options.auth);
  }
  const absoluteConfigPath = path.resolve(configPath);
  const projectStateRoot = resolveBootstrapProjectStateRoot(
    absoluteConfigPath,
    options.projectStateRoot,
  );
  const bootConfig = await loadBootConfig(absoluteConfigPath);
  const redactionRegistry = new MutableDynamicRedactionRegistry();
  const environmentSecrets = new EnvironmentSecretResolver();
  const auth = injectedAuth ?? {
    bearerToken: environmentSecrets.resolve(bootConfig.server.bearerToken),
    adminToken: environmentSecrets.resolve(bootConfig.server.adminToken),
  };
  const { bearerToken, adminToken } = auth;
  assertValidHttpAuth(auth);
  redactionRegistry.register(bearerToken);
  redactionRegistry.register(adminToken);
  const logger = createStructuredLogger({
    redactionRegistry,
    ...(options.log?.write === undefined ? {} : { write: options.log.write }),
    ...(options.log?.sensitiveKeys === undefined
      ? {}
      : { sensitiveKeys: options.log.sensitiveKeys }),
  });
  const faults = options.faults ?? noFaults;
  const databaseConfig = {
    ...bootConfig.database,
    path: path.resolve(path.dirname(absoluteConfigPath), bootConfig.database.path),
  };
  await mkdir(path.dirname(databaseConfig.path), { recursive: true });
  const connection = openDatabase(databaseConfig);
  let app: ReturnType<typeof createHttpApp> | undefined;
  let runWorker: RunWorker | undefined;
  let verificationWorker: ModelVerificationWorker | undefined;
  let expirer: ApprovalExpirer | undefined;
  let providerGateway: ProviderEgressGateway | undefined;
  let closed = false;
  let detachSignals = (): void => {};
  try {
    migrate(connection.db);
    const expectedMigrationVersions = readMigrationVersions(connection.db);
    const clock = options.clock ?? new SystemClock();
    const ids = new UuidIdGenerator();
    const catalogStore = new SqliteCatalogRepository(connection.db);
    const modelRegistry = new SqliteModelRegistryRepository(connection.db);
    const managedSecrets = new SqliteEncryptedSecretStore(connection.db, process.env);
    if (bootConfig.legacyModelImport !== undefined) {
      new ImportLegacyModelsService(modelRegistry, clock, ids).execute(
        bootConfig.legacyModelImport,
      );
    }
    const catalog = new CatalogService(await loadCatalog(absoluteConfigPath));
    const assignments = new AssignModelService(modelRegistry, clock, ids);
    assignments.synchronizeAgents(catalog.current().available.map(({ id }) => id));
    const secrets = new CompositeSecretResolver(
      environmentSecrets,
      managedSecrets,
      redactionRegistry,
    );
    const manageSecrets = new ManageSecretsService(
      managedSecrets,
      modelRegistry,
      clock,
      ids,
      {
        run: <Result>(operation: () => Result): Result =>
          withImmediateTransaction(connection.db, operation),
      },
    );
    const connections = new ManageProviderConnectionsService(
      modelRegistry,
      manageSecrets,
      clock,
      ids,
      {
        run: <Result>(operation: () => Result): Result =>
          withImmediateTransaction(connection.db, operation),
      },
    );
    const profiles = new ManageModelProfilesService(modelRegistry, clock, ids);
    const agents = new AgentResolver({
      catalog,
      registry: modelRegistry,
      secrets,
    });
    const providerTransport = new NodeProviderHttpTransport({
      secretResolver: secrets,
    });
    providerGateway = new ProviderEgressGateway({
      transport: providerTransport,
      ...(options.providerGateway?.listen === undefined
        ? {}
        : { listen: options.providerGateway.listen }),
      ...(options.providerGateway?.onStopped === undefined
        ? {}
        : { onStopped: options.providerGateway.onStopped }),
    });
    try {
      await providerGateway.start();
    } catch (error) {
      logger.error(
        { code: "provider_gateway_unavailable", error },
        "Pi provider egress gateway is unavailable",
      );
    }
    const providerModel = new ModelRuntimeRouter({
      piAi: new PiAiModelAdapter({
        client: new PiAiSdkClient(),
        gateway: providerGateway,
      }),
      chatCompletions: new OpenAiChatCompletionsModel({
        transport: providerTransport,
      }),
      responses: new OpenAiResponsesModel({
        transport: providerTransport,
      }),
    });
    const model = options.model ?? providerModel;
    const modelControl = bootConfig.version === 2
      ? bootConfig.modelControl
      : DEFAULT_MODEL_CONTROL;
    const discovery = new DiscoverModelsService(
      modelRegistry,
      new OpenAiModelDiscovery(providerTransport),
      ids,
      {
        cacheSeconds: modelControl.discoveryCacheSeconds,
        timeoutMs: modelControl.discoveryTimeoutMs,
        maxItems: modelControl.maxDiscoveredModels,
        maxResponseBytes: modelControl.maxDiscoveryResponseBytes,
      },
    );
    const verifications = new VerifyModelService({
      registry: modelRegistry,
      model,
      clock,
      ids,
      requestTimeoutMs: modelControl.verificationRequestTimeoutMs,
      jobTimeoutMs: modelControl.verificationJobTimeoutMs,
    });
    const runs = new SqliteRunRepository(connection.db, catalogStore);
    const tools = new SqliteToolRepository(connection.db);
    const approvals = new SqliteApprovalRepository(connection.db);
    const sessions = new SqliteSessionRepository(connection.db);
    const executions = new ExecutionRegistry();
    const policy = new PolicyEngine();
    const registry = new ToolRegistry();
    const delegate = new DelegateAgentService({ agents, runs, clock, ids });
    registry.register(activateSkillTool);
    registry.register(listFilesTool);
    registry.register(readFileTool);
    registry.register(writeFileTool);
    registry.register(createRunCommandTool({
      environmentAllowlist: catalog.current().global.toolEnvironmentAllowlist,
      secretResolver: secrets,
    }));
    registry.register(createDelegateAgentTool(delegate));
    const advance = new AdvanceRunService({
      runs,
      tools,
      approvals,
      sessions,
      model,
      prompts: new PromptAssembler(sessions),
      registry,
      policy,
      clock,
      ids,
      faults,
      modelRegistry,
    });
    runWorker = new RunWorker({
      runs,
      advance,
      clock,
      workerId: `worker-${randomUUID()}`,
      executions,
      faults,
      onUnexpectedRunError(error, runId) {
        logger.error(
          { code: "worker_run_failed", error, runId },
          "worker could not advance a claimed Run",
        );
      },
      onFatalError(error) {
        logger.error(
          { code: "worker_lane_failed", error },
          "worker lane stopped unexpectedly",
        );
      },
      ...options.worker,
    });
    expirer = new ApprovalExpirer({
      approvals,
      clock,
      onFatalError(error) {
        logger.error(
          { code: "approval_expirer_failed", error },
          "approval expiration worker stopped unexpectedly",
        );
      },
    });
    verificationWorker = new ModelVerificationWorker({
      registry: modelRegistry,
      verify: verifications,
      clock,
      workerId: `verification-${randomUUID()}`,
      concurrency: modelControl.verificationConcurrency,
      onUnexpectedVerificationError(error, verificationId) {
        logger.error(
          { code: "verification_job_failed", error, verificationId },
          "verification worker could not complete a claimed job",
        );
      },
      onFatalError(error) {
        logger.error(
          { code: "verification_worker_failed", error },
          "verification worker stopped unexpectedly",
        );
      },
    });
    const listen = {
      host: options.listen?.host ?? catalog.current().global.server.host,
      port: options.listen?.port ?? catalog.current().global.server.port,
    };
    app = createHttpApp({
      bearerToken,
      adminToken,
      modelControl: {
        registry: modelRegistry,
        connections,
        profiles,
        secrets: manageSecrets,
        assignments,
        discovery,
        verifications,
      },
      catalog,
      prepareCatalogReload(candidate) {
        assignments.synchronizeAgents(candidate.available.map(({ id }) => id));
      },
      createRuns: new CreateRunService(agents, runs, clock, ids),
      runs,
      cancelRuns: new CancelRunService(runs, executions, clock),
      approvals,
      decideApprovals: new DecideApprovalService(approvals, clock, faults),
      tools,
      reconcileTools: new ReconcileToolCallService({ tools, runs, policy, clock, ids }),
      sessions,
      deleteSession: new DeleteSessionService(sessions),
      createBackups: new CreateBackupService(
        new SqliteBackupWriter(connection.db),
        catalog,
        clock,
      ),
      createManagedAgents: new CreateManagedAgentService(catalog, {
        afterReload(candidate) {
          assignments.synchronizeAgents(candidate.available.map(({ id }) => id));
        },
      }),
      logger,
      readiness: createReadinessProbe(
        catalog,
        connection.db,
        expectedMigrationVersions,
        () => runWorker?.isHealthy() === true &&
          verificationWorker?.isHealthy() === true &&
          expirer?.isHealthy() === true,
      ),
      diagnostics: () => collectDiagnostics({
        config: async () => { await loadBootConfig(absoluteConfigPath); },
        permissions: () => projectStatePermissionsAvailable(projectStateRoot, databaseConfig.path, access),
        sqlite: () => arraysEqual(readMigrationVersions(connection.db), expectedMigrationVersions),
        secrets: () => activeSecretReferencesResolvable(modelRegistry, process.env, (versionId) => manageSecrets.assertVersionActive(versionId)),
        workers: () => runWorker?.isHealthy() === true && verificationWorker?.isHealthy() === true && expirer?.isHealthy() === true,
        gateway: () => providerGateway?.isAvailable === true,
        tty: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
        binding: () => isLoopbackHost(listen.host),
      }),
      sse: { faults },
    });
    runWorker.start();
    expirer.start();
    verificationWorker.start();
    const address = await app.listen(listen);
    if (!isLoopbackHost(listen.host)) {
      logger.warn(
        { code: "non_loopback_binding", host: listen.host },
        "HTTP listener is exposed beyond loopback",
      );
    }
    const shutdown = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      detachSignals();
      await cleanupResources([
        () => app?.close(),
        () => verificationWorker?.stop(),
        () => expirer?.stop(),
        () => runWorker?.stop(),
        () => providerGateway?.stop(),
        () => connection.close(),
      ]);
      logger.info({ code: "service_stopped" }, "service shutdown completed");
    };
    if (options.signals !== false) {
      const onSignal = (): void => {
        void shutdown().catch((error: unknown) => {
          logger.error({ code: "shutdown_failed", error }, "service shutdown failed");
          process.exitCode = 1;
        });
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      detachSignals = () => {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
      };
    }
    return { url: address, shutdown };
  } catch (error) {
    try {
      await cleanupResources([
        () => app?.close(),
        () => verificationWorker?.stop(),
        () => expirer?.stop(),
        () => runWorker?.stop(),
        () => providerGateway?.stop(),
        () => connection.close(),
      ]);
    } catch (cleanupError) {
      logger.error(
        { code: "startup_cleanup_failed", error: cleanupError },
        "startup cleanup failed",
      );
    }
    throw error;
  }
}

function createReadinessProbe(
  catalog: CatalogService,
  database: DatabaseSync,
  expectedMigrationVersions: readonly number[],
  workersReady: () => boolean,
): () => boolean {
  return () => {
    if (!workersReady()) return false;
    try {
      catalog.current();
    } catch {
      return false;
    }
    let transactionStarted = false;
    try {
      database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const currentMigrationVersions = readMigrationVersions(database);
      database.exec("ROLLBACK");
      transactionStarted = false;
      return arraysEqual(currentMigrationVersions, expectedMigrationVersions);
    } catch {
      if (transactionStarted) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // A closed or failed connection is already not ready.
        }
      }
      return false;
    }
  };
}

function readMigrationVersions(database: DatabaseSync): number[] {
  return (database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>)
    .map(({ version }) => version);
}

function arraysEqual(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertValidHttpAuth(auth: { bearerToken: string; adminToken: string }): void {
  if (auth.bearerToken.length === 0) throw new Error("http_bearer_token_required");
  if (auth.adminToken.length === 0) throw new Error("http_admin_token_required");
  if (auth.bearerToken === auth.adminToken) throw new Error("http_admin_token_must_differ");
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (
    normalized === "localhost"
    || normalized === "::1"
    || normalized === "[::1]"
    || normalized === "0:0:0:0:0:0:0:1"
    || normalized === "[0:0:0:0:0:0:0:1]"
  ) return true;
  const ipv4Mapped = normalized.match(/^\[?::ffff:(127(?:\.\d{1,3}){3})\]?$/);
  if (ipv4Mapped?.[1] !== undefined) return isLoopbackHost(ipv4Mapped[1]);
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

async function cleanupResources(
  actions: readonly (() => void | Promise<void> | undefined)[],
): Promise<void> {
  let firstError: unknown;
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}
