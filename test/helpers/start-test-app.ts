import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { createHttpApp } from "../../src/interfaces/http/app.js";
import type { SseStreamOptions } from "../../src/interfaces/http/sse.js";
import { SqliteApprovalRepository } from "../../src/adapters/sqlite/approval-repository.js";
import { SqliteCatalogRepository } from "../../src/adapters/sqlite/catalog-repository.js";
import { SqliteModelRegistryRepository } from "../../src/adapters/sqlite/model-registry-repository.js";
import { SqliteEncryptedSecretStore } from "../../src/adapters/sqlite/encrypted-secret-store.js";
import { openDatabase } from "../../src/adapters/sqlite/database.js";
import { withImmediateTransaction } from "../../src/adapters/sqlite/database.js";
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
import { AssignModelService } from "../../src/application/assign-model.js";
import { DiscoverModelsService } from "../../src/application/discover-models.js";
import { ManageModelProfilesService } from "../../src/application/manage-model-profiles.js";
import { ManageProviderConnectionsService } from "../../src/application/manage-provider-connections.js";
import { ManageSecretsService } from "../../src/application/manage-secrets.js";
import { VerifyModelService } from "../../src/application/verify-model.js";
import { ReconcileToolCallService } from "../../src/application/reconcile-tool-call.js";
import { CatalogService } from "../../src/config/catalog-service.js";
import { loadCatalog } from "../../src/config/catalog-loader.js";
import { ExecutionRegistry } from "../../src/runtime/execution-registry.js";
import type { ModelDiscoveryPort } from "../../src/ports/model-discovery.js";
import { FakeClock } from "./fake-clock.js";
import { tempPath } from "./temp-dir.js";
import { seedVerifiedChatAssignments } from "./verified-chat-model-registry.js";
import { ScriptedModel } from "./scripted-model.js";

const TEST_MASTER_KEY = "ERERERERERERERERERERERERERERERERERERERERERE=";

export async function startTestApp(
  options: {
    sse?: SseStreamOptions;
    configPath?: string;
    databasePath?: string;
    modelDiscovery?: ModelDiscoveryPort;
    logger?: FastifyBaseLogger;
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
  const managedSecrets = new SqliteEncryptedSecretStore(connection.db, {
    MYAGENT_MASTER_KEY: TEST_MASTER_KEY,
  });
  const manageSecrets = new ManageSecretsService(managedSecrets, modelRegistry, clock, ids);
  const manageConnections = new ManageProviderConnectionsService(
    modelRegistry,
    manageSecrets,
    clock,
    ids,
    { run: (operation) => withImmediateTransaction(connection.db, operation) },
  );
  const manageProfiles = new ManageModelProfilesService(modelRegistry, clock, ids);
  const discoveryPort = options.modelDiscovery ?? {
    discover: async () => ({ state: "unsupported" as const, models: [], fetchedAt: clock.now() }),
  };
  const discovery = new DiscoverModelsService(modelRegistry, discoveryPort, ids, {
    cacheSeconds: 600,
    timeoutMs: 10_000,
    maxItems: 1_000,
    maxResponseBytes: 2_097_152,
  });
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
    adminToken: "test-admin-token",
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    modelControl: {
      registry: modelRegistry,
      connections: manageConnections,
      profiles: manageProfiles,
      secrets: manageSecrets,
      assignments: new AssignModelService(modelRegistry, clock, ids),
      discovery,
      verifications: new VerifyModelService({
        registry: modelRegistry,
        model: new ScriptedModel(),
        clock,
        ids,
        requestTimeoutMs: 30_000,
        jobTimeoutMs: 120_000,
      }),
      now: () => clock.now(),
    },
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
  return { app, approvals, catalog, clock, connection, managedSecrets, modelRegistry, runs, sessions, tools, close: async () => { await app.close(); connection.close(); } };
}
