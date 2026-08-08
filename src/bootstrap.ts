import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

import type { DatabaseSync } from "node:sqlite";

import { EnvironmentSecretResolver } from "./adapters/environment-secret-resolver.js";
import { OpenAiChatCompletionsModel } from "./adapters/model/openai-chat-completions.js";
import { SqliteApprovalRepository } from "./adapters/sqlite/approval-repository.js";
import { SqliteBackupWriter } from "./adapters/sqlite/backup.js";
import { SqliteCatalogRepository } from "./adapters/sqlite/catalog-repository.js";
import { openDatabase } from "./adapters/sqlite/database.js";
import { migrate } from "./adapters/sqlite/migrator.js";
import { SqliteRunRepository } from "./adapters/sqlite/run-repository.js";
import { SqliteSessionRepository } from "./adapters/sqlite/session-repository.js";
import { SqliteToolRepository } from "./adapters/sqlite/tool-repository.js";
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
import { CancelRunService } from "./application/cancel-run.js";
import { CreateBackupService } from "./application/create-backup.js";
import { CreateRunService } from "./application/create-run.js";
import { DecideApprovalService } from "./application/decide-approval.js";
import { DelegateAgentService } from "./application/delegate-agent.js";
import { DeleteSessionService } from "./application/delete-session.js";
import { PolicyEngine } from "./application/policy-engine.js";
import { PromptAssembler } from "./application/prompt-assembler.js";
import { ReconcileToolCallService } from "./application/reconcile-tool-call.js";
import { loadCatalog } from "./config/catalog-loader.js";
import { CatalogService } from "./config/catalog-service.js";
import { createHttpApp } from "./interfaces/http/app.js";
import { createStructuredLogger } from "./observability/logger.js";
import { assertSupportedRuntime } from "./platform.js";
import { ApprovalExpirer } from "./runtime/approval-expirer.js";
import { ExecutionRegistry } from "./runtime/execution-registry.js";
import { noFaults, type FaultInjector } from "./runtime/fault-injector.js";
import { RunWorker } from "./runtime/run-worker.js";

export interface BootstrapOptions {
  listen?: { host?: string; port?: number };
  signals?: boolean;
  log?: {
    write?: (line: string) => void;
    sensitiveKeys?: readonly string[];
  };
  faults?: FaultInjector;
  worker?: {
    concurrency?: number;
    leaseDurationMs?: number;
    idleDelayMs?: number;
  };
}

export interface BootstrappedService {
  url: string;
  shutdown(): Promise<void>;
}

export async function bootstrap(
  configPath: string,
  options: BootstrapOptions = {},
): Promise<BootstrappedService> {
  assertSupportedRuntime();
  const catalog = new CatalogService(await loadCatalog(configPath));
  const secrets = new EnvironmentSecretResolver();
  const bearerToken = secrets.resolve(catalog.current().global.server.bearerToken);
  const resolvedModelSecrets: string[] = [];
  for (const model of Object.values(catalog.current().global.models)) {
    resolvedModelSecrets.push(secrets.resolve(model.apiKey));
  }
  const logger = createStructuredLogger({
    secretValues: [bearerToken, ...resolvedModelSecrets],
    ...(options.log?.write === undefined ? {} : { write: options.log.write }),
    ...(options.log?.sensitiveKeys === undefined
      ? {}
      : { sensitiveKeys: options.log.sensitiveKeys }),
  });
  const faults = options.faults ?? noFaults;
  await mkdir(path.dirname(catalog.current().global.database.path), { recursive: true });
  const connection = openDatabase(catalog.current().global.database);
  let app: ReturnType<typeof createHttpApp> | undefined;
  let worker: RunWorker | undefined;
  let expirer: ApprovalExpirer | undefined;
  let closed = false;
  let detachSignals = (): void => {};
  try {
    migrate(connection.db);
    const expectedMigrationVersions = readMigrationVersions(connection.db);
    const clock = new SystemClock();
    const ids = new UuidIdGenerator();
    const catalogStore = new SqliteCatalogRepository(connection.db);
    const runs = new SqliteRunRepository(connection.db, catalogStore);
    const tools = new SqliteToolRepository(connection.db);
    const approvals = new SqliteApprovalRepository(connection.db);
    const sessions = new SqliteSessionRepository(connection.db);
    const executions = new ExecutionRegistry();
    const policy = new PolicyEngine();
    const registry = new ToolRegistry();
    const delegate = new DelegateAgentService({ catalog, runs, clock, ids });
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
      model: new OpenAiChatCompletionsModel({ secretResolver: secrets }),
      prompts: new PromptAssembler(sessions),
      registry,
      policy,
      clock,
      ids,
      faults,
    });
    worker = new RunWorker({
      runs,
      advance,
      clock,
      workerId: `worker-${randomUUID()}`,
      executions,
      faults,
      ...options.worker,
    });
    expirer = new ApprovalExpirer({ approvals, clock });
    app = createHttpApp({
      bearerToken,
      catalog,
      createRuns: new CreateRunService(catalog, runs, clock, ids),
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
      logger,
      readiness: createReadinessProbe(catalog, connection.db, expectedMigrationVersions),
      sse: { faults },
    });
    worker.start();
    expirer.start();
    const listen = {
      host: options.listen?.host ?? catalog.current().global.server.host,
      port: options.listen?.port ?? catalog.current().global.server.port,
    };
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
        () => worker?.stop(),
        () => expirer?.stop(),
        () => connection.close(),
      ]);
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
        () => worker?.stop(),
        () => expirer?.stop(),
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
): () => boolean {
  return () => {
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
