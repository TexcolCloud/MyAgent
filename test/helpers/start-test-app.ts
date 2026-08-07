import { createHttpApp } from "../../src/interfaces/http/app.js";
import { SqliteApprovalRepository } from "../../src/adapters/sqlite/approval-repository.js";
import { SqliteCatalogRepository } from "../../src/adapters/sqlite/catalog-repository.js";
import { openDatabase } from "../../src/adapters/sqlite/database.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { SqliteRunRepository } from "../../src/adapters/sqlite/run-repository.js";
import { SqliteSessionRepository } from "../../src/adapters/sqlite/session-repository.js";
import { SqliteToolRepository } from "../../src/adapters/sqlite/tool-repository.js";
import { UuidIdGenerator } from "../../src/adapters/uuid-id-generator.js";
import { CancelRunService } from "../../src/application/cancel-run.js";
import { CreateRunService } from "../../src/application/create-run.js";
import { DecideApprovalService } from "../../src/application/decide-approval.js";
import { DeleteSessionService } from "../../src/application/delete-session.js";
import { ReconcileToolCallService } from "../../src/application/reconcile-tool-call.js";
import { CatalogService } from "../../src/config/catalog-service.js";
import { loadCatalog } from "../../src/config/catalog-loader.js";
import { ExecutionRegistry } from "../../src/runtime/execution-registry.js";
import { FakeClock } from "./fake-clock.js";
import { tempPath } from "./temp-dir.js";

export async function startTestApp() {
  const connection = openDatabase({ path: tempPath("http-test.db"), busyTimeoutMs: 5_000 });
  migrate(connection.db);
  const catalog = new CatalogService(await loadCatalog("test/fixtures/config/valid/myagent.yaml"));
  const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
  const ids = new UuidIdGenerator();
  const runs = new SqliteRunRepository(connection.db, new SqliteCatalogRepository(connection.db));
  const tools = new SqliteToolRepository(connection.db);
  const app = createHttpApp({
    bearerToken: "test-token",
    catalog,
    createRuns: new CreateRunService(catalog, runs, clock, ids),
    runs,
    cancelRuns: new CancelRunService(runs, new ExecutionRegistry(), clock),
    approvals: new SqliteApprovalRepository(connection.db),
    decideApprovals: new DecideApprovalService(new SqliteApprovalRepository(connection.db), clock),
    tools,
    reconcileTools: new ReconcileToolCallService({ tools, runs, policy: { decide: () => ({ effect: "deny", matchedRule: null }) }, clock, ids }),
    sessions: new SqliteSessionRepository(connection.db),
    deleteSession: new DeleteSessionService(new SqliteSessionRepository(connection.db)),
  });
  return { app, connection, runs, close: async () => { await app.close(); connection.close(); } };
}
