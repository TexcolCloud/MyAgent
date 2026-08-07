import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { SqliteCatalogRepository } from "../../src/adapters/sqlite/catalog-repository.js";
import { openDatabase, type SqliteDatabase } from "../../src/adapters/sqlite/database.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { SqliteRunRepository } from "../../src/adapters/sqlite/run-repository.js";
import { CreateRunService } from "../../src/application/create-run.js";
import { loadCatalog, type CatalogSnapshot } from "../../src/config/catalog-loader.js";
import { CatalogService } from "../../src/config/catalog-service.js";
import { runIdFromUuid, sessionIdFromUuid } from "../../src/domain/ids.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { FakeIds } from "../helpers/fake-ids.js";
import { tempPath } from "../helpers/temp-dir.js";

const claimWorkerOptions = process.env.MYAGENT_CLAIM_WORKER_OPTIONS;

if (claimWorkerOptions !== undefined) {
  describe("claim contention worker", () => {
    it("claims once in a child process", () => {
      runContentionWorker(JSON.parse(claimWorkerOptions) as ClaimWorkerOptions);
    });
  });
}

if (claimWorkerOptions === undefined) {
  describe("SqliteRunRepository queue", () => {
  let catalogSnapshot: CatalogSnapshot;

  beforeAll(async () => {
    catalogSnapshot = await loadCatalog(
      path.resolve("test/fixtures/config/valid/myagent.yaml"),
    );
  });

  it("claims one Run per Session while allowing another Session", () => {
    const harness = createQueueHarness(catalogSnapshot, "run-queue.db");
    const contenderConnection = openDatabase({
      path: harness.databasePath,
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(contenderConnection.db);
      const contender = new SqliteRunRepository(
        contenderConnection.db,
        new SqliteCatalogRepository(contenderConnection.db),
      );
      const a1 = create(harness.service, "session:a", "request-a001");
      const a2 = create(harness.service, "session:a", "request-a002");
      const b1 = create(harness.service, "session:b", "request-b001");
      const now = new Date("2026-08-07T00:00:01.000Z");
      const leaseUntil = new Date("2026-08-07T00:00:31.000Z");

      const first = harness.store.claimNextEligible("worker-1", now, leaseUntil);
      const second = contender.claimNextEligible("worker-2", now, leaseUntil);

      expect(new Set([first?.runId, second?.runId])).toEqual(
        new Set([a1.runId, b1.runId]),
      );
      expect(harness.store.getRun(a2.runId).state).toBe("queued");
    } finally {
      contenderConnection.close();
      harness.connection.close();
    }
  });

  it("claims the lowest FIFO sequence when timestamps tie and Run IDs reverse", () => {
    const harness = createQueueHarness(catalogSnapshot, "fifo-tie-break.db", {
      sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000001")],
      runIds: [
        runIdFromUuid("00000000-0000-7000-8000-000000000002"),
        runIdFromUuid("00000000-0000-7000-8000-000000000001"),
      ],
    });
    try {
      const first = create(harness.service, "session:a", "request-a001");
      create(harness.service, "session:a", "request-a002");

      expect(
        harness.store.claimNextEligible(
          "worker-1",
          new Date("2026-08-07T00:00:01.000Z"),
          new Date("2026-08-07T00:00:30.000Z"),
        )?.runId,
      ).toBe(first.runId);
    } finally {
      harness.connection.close();
    }
  });

  it("serializes overlapping child-process claims through SQLite's busy timeout", async () => {
    const harness = createQueueHarness(catalogSnapshot, "claim-contention.db");
    const startPath = tempPath("claim-contention.start");
    const retryPath = tempPath("claim-contention.retry");
    const now = new Date("2026-08-07T00:00:01.000Z");
    const leaseUntil = new Date("2026-08-07T00:00:30.000Z");
    let writerTransactionOpen = false;
    const workers: ContentionWorker[] = [];
    try {
      const created = create(harness.service, "session:a", "request-a001");
      harness.connection.db.exec("BEGIN IMMEDIATE");
      writerTransactionOpen = true;

      workers.push(
        startContentionWorker(
          harness.databasePath,
          startPath,
          retryPath,
          "worker-1",
          now,
          leaseUntil,
        ),
        startContentionWorker(
          harness.databasePath,
          startPath,
          retryPath,
          "worker-2",
          now,
          leaseUntil,
        ),
      );
      await Promise.all(workers.map((worker) => waitForFile(worker.readyPath)));
      writeFileSync(startPath, "start");
      await Promise.all(workers.map((worker) => waitForFile(worker.blockedPath)));

      expect(harness.store.getRun(created.runId).state).toBe("queued");
      harness.connection.db.exec("COMMIT");
      writerTransactionOpen = false;
      writeFileSync(retryPath, "retry");

      await Promise.all(workers.map((worker) => worker.completed));
      const results = workers.map((worker) =>
        JSON.parse(readFileSync(worker.resultPath, "utf8")) as ClaimWorkerResult,
      );
      expect(results.map((result) => result.runId).filter(Boolean)).toEqual([
        created.runId,
      ]);
      expect(harness.store.getRun(created.runId).state).toBe("running");
    } finally {
      if (writerTransactionOpen) {
        harness.connection.db.exec("ROLLBACK");
      }
      workers.forEach((worker) => worker.child.kill());
      harness.connection.close();
    }
  }, 10_000);

  it("reclaims an expired running Run without a duplicate started event", () => {
    const harness = createQueueHarness(catalogSnapshot, "run-reclaim.db");
    try {
      const created = create(harness.service, "session:a", "request-a001");
      harness.store.claimNextEligible(
        "worker-1",
        new Date("2026-08-07T00:00:01.000Z"),
        new Date("2026-08-07T00:00:10.000Z"),
      );

      const reclaimed = harness.store.claimNextEligible(
        "worker-2",
        new Date("2026-08-07T00:00:11.000Z"),
        new Date("2026-08-07T00:00:20.000Z"),
      );

      expect(reclaimed?.runId).toBe(created.runId);
      expect(
        harness.store
          .listEventsAfter(created.runId, 0)
          .filter((event) => event.type === "run.started"),
      ).toHaveLength(1);
    } finally {
      harness.connection.close();
    }
  });

  it("appends committed Run events without sequence gaps", () => {
    const harness = createQueueHarness(catalogSnapshot, "event-append.db");
    try {
      const created = create(harness.service, "session:a", "request-a001");

      harness.store.appendEvent(
        created.runId,
        "message.delta",
        { text: "first" },
        new Date("2026-08-07T00:00:01.000Z"),
      );
      harness.store.appendEvent(
        created.runId,
        "message.completed",
        { text: "done" },
        new Date("2026-08-07T00:00:02.000Z"),
      );

      expect(
        harness.store.listEventsAfter(created.runId, 0).map((event) => event.sequence),
      ).toEqual([1, 2, 3]);
    } finally {
      harness.connection.close();
    }
  });

  it("renews and releases a lease only for its current owner", () => {
    const harness = createQueueHarness(catalogSnapshot, "lease-ownership.db");
    try {
      const created = create(harness.service, "session:a", "request-a001");
      harness.store.claimNextEligible(
        "worker-1",
        new Date("2026-08-07T00:00:01.000Z"),
        new Date("2026-08-07T00:00:10.000Z"),
      );

      expect(
        harness.store.renewLease(
          created.runId,
          "worker-other",
          new Date("2026-08-07T00:00:20.000Z"),
        ),
      ).toBe(false);
      expect(
        harness.store.renewLease(
          created.runId,
          "worker-1",
          new Date("2026-08-07T00:00:20.000Z"),
        ),
      ).toBe(true);
      expect(
        harness.store.claimNextEligible(
          "worker-2",
          new Date("2026-08-07T00:00:11.000Z"),
          new Date("2026-08-07T00:00:30.000Z"),
        ),
      ).toBeNull();
      expect(harness.store.releaseLease(created.runId, "worker-other")).toBe(false);
      expect(harness.store.releaseLease(created.runId, "worker-1")).toBe(true);

      expect(
        harness.store.claimNextEligible(
          "worker-2",
          new Date("2026-08-07T00:00:12.000Z"),
          new Date("2026-08-07T00:00:30.000Z"),
        )?.runId,
      ).toBe(created.runId);
    } finally {
      harness.connection.close();
    }
  });

  it("does not expose a later queued Operator message to an earlier Run", () => {
    const harness = createQueueHarness(catalogSnapshot, "message-visibility.db");
    try {
      const first = create(harness.service, "session:a", "request-a001");
      create(harness.service, "session:a", "request-a002");
      const firstRun = harness.store.getRun(first.runId);

      expect(
        harness.connection.db
          .prepare(
            `SELECT content_json
             FROM messages
             WHERE session_id = ? AND run_fifo_sequence <= ?
             ORDER BY sequence`,
          )
          .all(firstRun.sessionId, firstRun.fifoSequence),
      ).toEqual([{ content_json: '{"text":"session:a","type":"text"}' }]);
    } finally {
      harness.connection.close();
    }
  });

  it("returns the original Run after reopening the database", () => {
    const harness = createQueueHarness(catalogSnapshot, "idempotency-reopen.db");
    const reopened = openDatabase({
      path: harness.databasePath,
      busyTimeoutMs: 5_000,
    });
    try {
      const first = create(harness.service, "session:a", "request-a001");
      migrate(reopened.db);
      const retryService = new CreateRunService(
        new CatalogService(catalogSnapshot),
        new SqliteRunRepository(
          reopened.db,
          new SqliteCatalogRepository(reopened.db),
        ),
        new FakeClock(new Date("2026-08-07T00:01:00.000Z")),
        new FakeIds(),
      );

      expect(create(retryService, "session:a", "request-a001")).toEqual({
        ...first,
        created: false,
      });
    } finally {
      reopened.close();
      harness.connection.close();
    }
  });

  it("rolls back a claim when its matching started event cannot commit", () => {
    const harness = createQueueHarness(catalogSnapshot, "claim-rollback.db");
    try {
      const created = create(harness.service, "session:a", "request-a001");
      harness.connection.db.exec(`
        CREATE TRIGGER reject_run_started
        BEFORE INSERT ON run_events
        WHEN NEW.event_type = 'run.started'
        BEGIN
          SELECT RAISE(ABORT, 'reject_run_started');
        END
      `);

      expect(() =>
        harness.store.claimNextEligible(
          "worker-1",
          new Date("2026-08-07T00:00:01.000Z"),
          new Date("2026-08-07T00:00:30.000Z"),
        ),
      ).toThrowError("reject_run_started");
      expect(harness.store.getRun(created.runId).state).toBe("queued");
      expect(harness.store.listEventsAfter(created.runId, 0).map((event) => event.type))
        .toEqual(["run.queued"]);
      expect(
        harness.connection.db
          .prepare("SELECT lease_owner FROM runs WHERE run_id = ?")
          .get(created.runId),
      ).toEqual({ lease_owner: null });
    } finally {
      harness.connection.close();
    }
  });
  });
}

interface QueueHarness {
  connection: SqliteDatabase;
  databasePath: string;
  service: CreateRunService;
  store: SqliteRunRepository;
}

function createQueueHarness(
  snapshot: CatalogSnapshot,
  fileName: string,
  ids: ConstructorParameters<typeof FakeIds>[0] = {
    sessionIds: [
      sessionIdFromUuid("00000000-0000-7000-8000-000000000001"),
      sessionIdFromUuid("00000000-0000-7000-8000-000000000002"),
      sessionIdFromUuid("00000000-0000-7000-8000-000000000003"),
    ],
    runIds: [
      runIdFromUuid("00000000-0000-7000-8000-000000000001"),
      runIdFromUuid("00000000-0000-7000-8000-000000000002"),
      runIdFromUuid("00000000-0000-7000-8000-000000000003"),
      runIdFromUuid("00000000-0000-7000-8000-000000000004"),
    ],
  },
): QueueHarness {
  const databasePath = tempPath(fileName);
  const connection = openDatabase({ path: databasePath, busyTimeoutMs: 5_000 });
  migrate(connection.db);
  const store = new SqliteRunRepository(
    connection.db,
    new SqliteCatalogRepository(connection.db),
  );
  const service = new CreateRunService(
    new CatalogService(snapshot),
    store,
    new FakeClock(new Date("2026-08-07T00:00:00.000Z")),
    new FakeIds(ids),
  );
  return { connection, databasePath, service, store };
}

function create(
  service: CreateRunService,
  sessionKey: string,
  idempotencyKey: string,
) {
  return service.execute({
    agentId: "primary",
    sessionKey,
    input: { type: "text", text: sessionKey },
    idempotencyKey,
    source: { kind: "http" },
  });
}

interface ClaimWorkerResult {
  runId: string | null;
}

interface ClaimWorkerOptions {
  databasePath: string;
  startPath: string;
  retryPath: string;
  readyPath: string;
  blockedPath: string;
  resultPath: string;
  leaseOwner: string;
  now: string;
  leaseUntil: string;
}

interface ContentionWorker {
  child: ChildProcess;
  readyPath: string;
  blockedPath: string;
  resultPath: string;
  completed: Promise<void>;
}

function startContentionWorker(
  databasePath: string,
  startPath: string,
  retryPath: string,
  leaseOwner: string,
  now: Date,
  leaseUntil: Date,
): ContentionWorker {
  const workerToken = leaseOwner.replaceAll(/[^a-zA-Z0-9]/g, "-");
  const options: ClaimWorkerOptions = {
    databasePath,
    startPath,
    retryPath,
    readyPath: tempPath(`claim-contention-${workerToken}.ready`),
    blockedPath: tempPath(`claim-contention-${workerToken}.blocked`),
    resultPath: tempPath(`claim-contention-${workerToken}.result`),
    leaseOwner,
    now: now.toISOString(),
    leaseUntil: leaseUntil.toISOString(),
  };
  const child = spawn(
    process.execPath,
    [
      path.resolve("node_modules/vitest/vitest.mjs"),
      "run",
      "test/integration/run-queue.test.ts",
      "--reporter=dot",
    ],
    {
      env: {
        ...process.env,
        MYAGENT_CLAIM_WORKER_OPTIONS: JSON.stringify(options),
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const stderr: string[] = [];
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => stderr.push(chunk));

  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`claim worker exited with ${code}: ${stderr.join("")}`));
      }
    });
  });

  return {
    child,
    readyPath: options.readyPath,
    blockedPath: options.blockedPath,
    resultPath: options.resultPath,
    completed,
  };
}

function runContentionWorker(options: ClaimWorkerOptions): void {
  const probeConnection = openDatabase({
    path: options.databasePath,
    busyTimeoutMs: 100,
  });
  try {
    const probeStore = new SqliteRunRepository(
      probeConnection.db,
      new SqliteCatalogRepository(probeConnection.db),
    );
    writeFileSync(options.readyPath, "ready");
    waitForFileSync(options.startPath);
    try {
      probeStore.claimNextEligible(
        options.leaseOwner,
        new Date(options.now),
        new Date(options.leaseUntil),
      );
      throw new Error("expected the held writer lock to exhaust busy_timeout");
    } catch (error) {
      if (!isSqliteBusy(error)) {
        throw error;
      }
      writeFileSync(options.blockedPath, "blocked");
    }
  } finally {
    probeConnection.close();
  }

  waitForFileSync(options.retryPath);
  const retryConnection = openDatabase({
    path: options.databasePath,
    busyTimeoutMs: 2_000,
  });
  try {
    const retryStore = new SqliteRunRepository(
      retryConnection.db,
      new SqliteCatalogRepository(retryConnection.db),
    );
    const run = retryStore.claimNextEligible(
      options.leaseOwner,
      new Date(options.now),
      new Date(options.leaseUntil),
    );
    writeFileSync(options.resultPath, JSON.stringify({ runId: run?.runId ?? null }));
  } finally {
    retryConnection.close();
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const sqliteError = error as Error & { errcode?: unknown };
  return sqliteError.errcode === 5 && sqliteError.message === "database is locked";
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function waitForFileSync(filePath: string): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(filePath)) {
    Atomics.wait(signal, 0, 0, 10);
  }
}
