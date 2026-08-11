import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyBaseLogger } from "fastify";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createHttpApp } from "../../src/interfaces/http/app.js";
import { bootstrap, type BootstrappedService } from "../../src/bootstrap.js";
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
const REAL_RUN_TOKEN = "run-test-token";
const REAL_ADMIN_TOKEN = "admin-test-token";
const EXAMPLES = fileURLToPath(new URL("../../examples", import.meta.url));

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
  const manageSecrets = new ManageSecretsService(
    managedSecrets,
    modelRegistry,
    clock,
    ids,
    { run: (operation) => withImmediateTransaction(connection.db, operation) },
  );
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

export interface RealTestEvent {
  readonly runId: string;
  readonly sequence: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export interface VerifiedModelSetup {
  readonly connectionId: string;
  readonly connectionRevisionId: string;
  readonly profileId: string;
  readonly profileRevisionId: string;
  readonly verificationId: string;
}

export interface AsyncCleanupStack {
  use<T>(resource: T, cleanup: (resource: T) => Promise<void> | void): T;
  dispose(): Promise<void>;
}

export function createAsyncCleanupStack(): AsyncCleanupStack {
  const cleanups: Array<() => Promise<void> | void> = [];
  let disposed = false;
  return {
    use<T>(resource: T, cleanup: (resource: T) => Promise<void> | void): T {
      if (disposed) throw new Error("cleanup_stack_disposed");
      cleanups.push(() => cleanup(resource));
      return resource;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      let firstError: unknown;
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError !== undefined) throw firstError;
    },
  };
}

export async function startRealTestApp(options: {
  readonly verificationRequestTimeoutMs?: number;
  readonly listenPort?: number;
  readonly onRootCreated?: (root: string) => void;
} = {}): Promise<{
  readonly root: string;
  readonly url: string;
  readonly configPath: string;
  readonly databasePath: string;
  readonly primaryWorkspace: string;
  readonly logs: readonly string[];
  readonly setupResponseBodies: readonly string[];
  setupVerifiedModel(input: {
    connectionSlug: string;
    profileSlug: string;
    providerBaseUrl: string;
    modelId: string;
    protocol: "chat_completions" | "responses";
    agentId: string;
    apiKeyEnvironment?: string;
    apiKey?: string;
    providerKind?: "openai" | "deepseek" | "openai_compatible";
    verificationTimeoutMs?: number;
  }): Promise<VerifiedModelSetup>;
  createRun(input: {
    agentId: string;
    sessionKey: string;
    text: string;
    idempotencyKey: string;
  }): Promise<{ runId: string }>;
  waitForRunStatus(runId: string, expected: string, timeoutMs?: number): Promise<{ status: string }>;
  waitForRunEvent(runId: string, eventType: string, afterSequence?: number, timeoutMs?: number): Promise<RealTestEvent>;
  readRunEvents(runId: string, afterSequence?: number): Promise<RealTestEvent[]>;
  onlyPendingApproval(): Promise<{ approvalId: string; runId: string }>;
  approve(approvalId: string): Promise<void>;
  adminRequest(pathname: string, init?: RequestInit): Promise<Response>;
  runRequest(pathname: string, init?: RequestInit): Promise<Response>;
  stop(): Promise<void>;
  restart(options?: { masterKey?: string }): Promise<void>;
  close(): Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-real-e2e-"));
  options.onRootCreated?.(root);
  const configRoot = path.join(root, "config");
  await cp(EXAMPLES, configRoot, { recursive: true });
  const configPath = path.join(configRoot, "myagent.yaml");
  const databasePath = path.join(configRoot, "data", "kernel.db");
  const primaryWorkspace = path.join(configRoot, "agents", "primary", "workspace");
  await Promise.all([
    mkdir(path.dirname(databasePath), { recursive: true }),
    mkdir(primaryWorkspace, { recursive: true }),
    mkdir(path.join(configRoot, "agents", "researcher", "workspace"), { recursive: true }),
  ]);
  if (options.verificationRequestTimeoutMs !== undefined) {
    const config = parseYaml(await readFile(configPath, "utf8")) as {
      modelControl: Record<string, unknown>;
    };
    config.modelControl.verificationRequestTimeoutMs = options.verificationRequestTimeoutMs;
    await writeFile(configPath, stringifyYaml(config), "utf8");
  }

  const previousRunToken = process.env.MYAGENT_BEARER_TOKEN;
  const previousAdminToken = process.env.MYAGENT_ADMIN_TOKEN;
  const previousMasterKey = process.env.MYAGENT_MASTER_KEY;
  process.env.MYAGENT_BEARER_TOKEN = REAL_RUN_TOKEN;
  process.env.MYAGENT_ADMIN_TOKEN = REAL_ADMIN_TOKEN;
  process.env.MYAGENT_MASTER_KEY = TEST_MASTER_KEY;

  const logs: string[] = [];
  const setupResponseBodies: string[] = [];
  let service: BootstrappedService | undefined;
  let closed = false;

  const start = async (): Promise<void> => {
    if (service !== undefined) return;
    service = await bootstrap(configPath, {
      listen: { host: "127.0.0.1", port: options.listenPort ?? 0 },
      signals: false,
      log: { write: (line) => logs.push(line) },
      worker: { concurrency: 1, idleDelayMs: 10, leaseDurationMs: 1_000 },
    });
  };
  const stop = async (): Promise<void> => {
    const active = service;
    service = undefined;
    await active?.shutdown();
  };
  const baseUrl = (): string => {
    if (service === undefined) throw new Error("real_test_service_not_started");
    return service.url;
  };
  const request = async (
    token: string,
    pathname: string,
    init: RequestInit = {},
  ): Promise<Response> => fetch(`${baseUrl()}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  const adminRequest = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    request(REAL_ADMIN_TOKEN, `/v1/admin${pathname}`, init);
  const setupAdminRequest = async (
    pathname: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const response = await adminRequest(pathname, init);
    setupResponseBodies.push(await response.clone().text());
    return response;
  };
  const runRequest = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    request(REAL_RUN_TOKEN, pathname, init);
  const requireStatus = async (
    response: Response,
    status: number,
    operation: string,
  ): Promise<Response> => {
    if (response.status !== status) {
      throw new Error(`${operation}_failed:${String(response.status)}`);
    }
    return response;
  };

  try {
    await start();
  } catch (error) {
    restoreEnvironment("MYAGENT_BEARER_TOKEN", previousRunToken);
    restoreEnvironment("MYAGENT_ADMIN_TOKEN", previousAdminToken);
    restoreEnvironment("MYAGENT_MASTER_KEY", previousMasterKey);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    get url(): string { return baseUrl(); },
    configPath,
    databasePath,
    primaryWorkspace,
    logs,
    setupResponseBodies,
    async setupVerifiedModel(input): Promise<VerifiedModelSetup> {
      if (input.apiKey !== undefined && input.apiKeyEnvironment !== undefined) {
        throw new Error("real_test_provider_auth_ambiguous");
      }
      const connectionResponse = await requireStatus(await setupAdminRequest(
        "/provider-connections",
        {
          method: "POST",
          body: JSON.stringify({
            slug: input.connectionSlug,
            displayName: input.connectionSlug,
            kind: input.providerKind ?? "openai_compatible",
            baseUrl: input.providerBaseUrl,
            auth: input.apiKey !== undefined
              ? { type: "api_key" }
              : input.apiKeyEnvironment === undefined
                ? { type: "none" }
                : { type: "environment", fromEnvironment: input.apiKeyEnvironment },
            ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
            protocolPreference: input.protocol,
          }),
        },
      ), 201, "create_connection");
      const connection = await connectionResponse.json() as {
        connectionId: string;
        revisions: Array<{ revisionId: string }>;
      };
      const connectionRevisionId = connection.revisions[0]?.revisionId;
      if (connectionRevisionId === undefined) throw new Error("connection_revision_missing");

      const discoveryResponse = await requireStatus(await setupAdminRequest(
        `/provider-connection-revisions/${connectionRevisionId}/discover`,
        { method: "POST", body: JSON.stringify({ expectedRevision: 0 }) },
      ), 200, "discover_models");
      const discovery = await discoveryResponse.json() as { recordRevision: number };

      const profileResponse = await requireStatus(await setupAdminRequest(
        "/model-profiles",
        {
          method: "POST",
          body: JSON.stringify({
            slug: input.profileSlug,
            displayName: input.profileSlug,
            connectionRevisionId,
            modelId: input.modelId,
            protocol: input.protocol,
            maxInputTokens: 32_768,
            contextWindowSource: "operator",
          }),
        },
      ), 201, "create_profile");
      const profile = await profileResponse.json() as {
        profileId: string;
        recordRevision: number;
        revisions: Array<{ revisionId: string }>;
      };
      const profileRevisionId = profile.revisions[0]?.revisionId;
      if (profileRevisionId === undefined) throw new Error("profile_revision_missing");

      const queuedResponse = await requireStatus(await setupAdminRequest(
        `/model-profile-revisions/${profileRevisionId}/verifications`,
        {
          method: "POST",
          body: JSON.stringify({
            expectedRevision: profile.recordRevision,
            capabilityBaseline: "text_and_single_tool_call_v1",
          }),
        },
      ), 202, "queue_verification");
      const queued = await queuedResponse.json() as { verificationId: string };
      const verification = await waitForVerification(
        () => setupAdminRequest(`/model-verifications/${queued.verificationId}`),
        input.verificationTimeoutMs ?? 10_000,
      );
      if (verification.status !== "passed") {
        throw new Error(`verification_failed:${verification.resultCode ?? verification.status}`);
      }

      await requireStatus(await setupAdminRequest(
        `/provider-connections/${connection.connectionId}/promotions`,
        {
          method: "POST",
          body: JSON.stringify({
            connectionRevisionId,
            expectedRevision: discovery.recordRevision,
          }),
        },
      ), 200, "promote_connection");
      const currentProfileResponse = await requireStatus(
        await setupAdminRequest(`/model-profiles/${profile.profileId}`),
        200,
        "read_profile",
      );
      const currentProfile = await currentProfileResponse.json() as { recordRevision: number };
      await requireStatus(await setupAdminRequest(
        `/model-profiles/${profile.profileId}/promotions`,
        {
          method: "POST",
          body: JSON.stringify({
            profileRevisionId,
            expectedRevision: currentProfile.recordRevision,
          }),
        },
      ), 200, "promote_profile");
      const currentAssignmentResponse = await requireStatus(
        await setupAdminRequest(`/agents/${input.agentId}/model-assignment`),
        200,
        "read_assignment",
      );
      const currentAssignment = await currentAssignmentResponse.json() as {
        recordRevision: number | null;
      };
      await requireStatus(await setupAdminRequest(
        `/agents/${input.agentId}/model-assignment`,
        {
          method: "PUT",
          body: JSON.stringify({
            modelProfileRevisionId: profileRevisionId,
            expectedRevision: currentAssignment.recordRevision ?? 0,
          }),
        },
      ), 200, "assign_model");
      return {
        connectionId: connection.connectionId,
        connectionRevisionId,
        profileId: profile.profileId,
        profileRevisionId,
        verificationId: queued.verificationId,
      };
    },
    async createRun(input): Promise<{ runId: string }> {
      const response = await requireStatus(await runRequest("/v1/runs", {
        method: "POST",
        headers: { "idempotency-key": input.idempotencyKey },
        body: JSON.stringify({
          agentId: input.agentId,
          sessionKey: input.sessionKey,
          input: { type: "text", text: input.text },
        }),
      }), 202, "create_run");
      return await response.json() as { runId: string };
    },
    async waitForRunStatus(runId, expected, timeoutMs = 15_000): Promise<{ status: string }> {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const response = await requireStatus(
          await runRequest(`/v1/runs/${runId}`),
          200,
          "read_run",
        );
        const run = await response.json() as { status: string };
        if (run.status === expected) return run;
        if (Date.now() >= deadline) throw new Error(`run_status_timeout:${run.status}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    waitForRunEvent(runId, eventType, afterSequence = 0, timeoutMs = 15_000) {
      return waitForRealEvent(
        () => runRequest(`/v1/runs/${runId}/events`, {
          headers: { "last-event-id": String(afterSequence) },
        }),
        eventType,
        timeoutMs,
      );
    },
    async readRunEvents(runId, afterSequence = 0): Promise<RealTestEvent[]> {
      const response = await requireStatus(await runRequest(`/v1/runs/${runId}/events`, {
        headers: { "last-event-id": String(afterSequence) },
      }), 200, "read_events");
      return parseEventStream(await response.text());
    },
    async onlyPendingApproval(): Promise<{ approvalId: string; runId: string }> {
      const response = await requireStatus(
        await runRequest("/v1/approvals?status=pending"),
        200,
        "read_approvals",
      );
      const body = await response.json() as {
        approvals: Array<{ approvalId: string; runId: string }>;
      };
      if (body.approvals.length !== 1) {
        throw new Error(`expected_one_pending_approval:${String(body.approvals.length)}`);
      }
      return body.approvals[0]!;
    },
    async approve(approvalId): Promise<void> {
      await requireStatus(await runRequest(`/v1/approvals/${approvalId}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
      }), 200, "approve");
    },
    adminRequest,
    runRequest,
    stop,
    async restart(options = {}): Promise<void> {
      await stop();
      process.env.MYAGENT_MASTER_KEY = options.masterKey ?? TEST_MASTER_KEY;
      await start();
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await stop();
      } finally {
        restoreEnvironment("MYAGENT_BEARER_TOKEN", previousRunToken);
        restoreEnvironment("MYAGENT_ADMIN_TOKEN", previousAdminToken);
        restoreEnvironment("MYAGENT_MASTER_KEY", previousMasterKey);
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

async function waitForVerification(
  read: () => Promise<Response>,
  timeoutMs: number,
): Promise<{ status: string; resultCode: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const response = await read();
    if (response.status !== 200) {
      throw new Error(`read_verification_failed:${String(response.status)}`);
    }
    const verification = await response.json() as {
      status: string;
      resultCode: string | null;
    };
    if (["passed", "failed", "cancelled"].includes(verification.status)) {
      return verification;
    }
    if (Date.now() >= deadline) throw new Error(`verification_timeout:${verification.status}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForRealEvent(
  read: () => Promise<Response>,
  eventType: string,
  timeoutMs: number,
): Promise<RealTestEvent> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await read();
    if (response.status !== 200 || response.body === null) {
      throw new Error(`event_stream_failed:${String(response.status)}`);
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!controller.signal.aborted) {
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(new Error(`event_timeout:${eventType}`)),
            { once: true },
          );
        }),
      ]);
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true }).replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const event = parseEventBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (event?.type === eventType) return event;
        boundary = buffer.indexOf("\n\n");
      }
    }
    throw new Error(`event_stream_ended:${eventType}`);
  } finally {
    clearTimeout(timeout);
    await reader?.cancel().catch(() => undefined);
  }
}

function parseEventStream(payload: string): RealTestEvent[] {
  return payload.replaceAll("\r\n", "\n")
    .split("\n\n")
    .map(parseEventBlock)
    .filter((event): event is RealTestEvent => event !== null);
}

function parseEventBlock(block: string): RealTestEvent | null {
  if (block.startsWith(":")) return null;
  const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
  return data === undefined ? null : JSON.parse(data) as RealTestEvent;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
