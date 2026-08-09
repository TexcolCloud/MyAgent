import { randomUUID } from "node:crypto";
import { createHttpApp } from "../../src/interfaces/http/app.js";
import type { SseStreamOptions } from "../../src/interfaces/http/sse.js";
import { SqliteApprovalRepository } from "../../src/adapters/sqlite/approval-repository.js";
import { SqliteCatalogRepository } from "../../src/adapters/sqlite/catalog-repository.js";
import { SqliteModelRegistryRepository } from "../../src/adapters/sqlite/model-registry-repository.js";
import { openDatabase } from "../../src/adapters/sqlite/database.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { SqliteRunRepository } from "../../src/adapters/sqlite/run-repository.js";
import { SqliteSessionRepository } from "../../src/adapters/sqlite/session-repository.js";
import { SqliteToolRepository } from "../../src/adapters/sqlite/tool-repository.js";
import { SqliteBackupWriter } from "../../src/adapters/sqlite/backup.js";
import { UuidIdGenerator } from "../../src/adapters/uuid-id-generator.js";
import { CancelRunService } from "../../src/application/cancel-run.js";
import { CreateBackupService } from "../../src/application/create-backup.js";
import { CreateRunService } from "../../src/application/create-run.js";
import { DecideApprovalService } from "../../src/application/decide-approval.js";
import { DeleteSessionService } from "../../src/application/delete-session.js";
import { AgentResolver } from "../../src/application/agent-resolver.js";
import { ReconcileToolCallService } from "../../src/application/reconcile-tool-call.js";
import { CatalogService } from "../../src/config/catalog-service.js";
import { loadCatalog } from "../../src/config/catalog-loader.js";
import { ExecutionRegistry } from "../../src/runtime/execution-registry.js";
import { FakeClock } from "./fake-clock.js";
import { tempPath } from "./temp-dir.js";
import { seedVerifiedChatAssignments } from "./verified-chat-model-registry.js";

export async function startTestApp(
  options: {
    sse?: SseStreamOptions;
    configPath?: string;
    databasePath?: string;
  } = {},
) {
  const connection = openDatabase({
    path: options.databasePath ?? tempPath(`http-test-${randomUUID()}.db`),
    busyTimeoutMs: 5_000,
  });
  migrate(connection.db);
  const catalog = new CatalogService(await loadCatalog(
    options.configPath ?? "test/fixtures/config/valid/myagent.yaml",
  ));
  const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
  const ids = new UuidIdGenerator();
  const runs = new SqliteRunRepository(connection.db, new SqliteCatalogRepository(connection.db));
  const modelRegistry = new SqliteModelRegistryRepository(connection.db);
  seedVerifiedChatAssignments(modelRegistry, catalog.current().available.map(({ id }) => id));
  const agents = new AgentResolver({
    catalog,
    registry: modelRegistry,
    secrets: { resolve: () => "unused" },
  });
  const tools = new SqliteToolRepository(connection.db);
  const approvals = new SqliteApprovalRepository(connection.db);
  const sessions = new SqliteSessionRepository(connection.db);
  const app = createHttpApp({
    bearerToken: "test-token",
    catalog,
    createRuns: new CreateRunService(agents, runs, clock, ids),
    runs,
    cancelRuns: new CancelRunService(runs, new ExecutionRegistry(), clock),
    approvals,
    decideApprovals: new DecideApprovalService(approvals, clock),
    tools,
    reconcileTools: new ReconcileToolCallService({ tools, runs, policy: { decide: () => ({ effect: "deny", matchedRule: null }) }, clock, ids }),
    sessions,
    deleteSession: new DeleteSessionService(sessions),
    ...(options.sse === undefined ? {} : { sse: options.sse }),
    createBackups: new CreateBackupService(new SqliteBackupWriter(connection.db), catalog, clock),
  });
  return { app, approvals, catalog, clock, connection, runs, sessions, tools, close: async () => { await app.close(); connection.close(); } };
}
