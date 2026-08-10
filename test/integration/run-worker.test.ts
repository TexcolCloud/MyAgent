import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { SqliteApprovalRepository } from "../../src/adapters/sqlite/approval-repository.js";
import { SqliteCatalogRepository } from "../../src/adapters/sqlite/catalog-repository.js";
import { openDatabase } from "../../src/adapters/sqlite/database.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { SqliteRunRepository } from "../../src/adapters/sqlite/run-repository.js";
import { SqliteSessionRepository } from "../../src/adapters/sqlite/session-repository.js";
import { SqliteToolRepository } from "../../src/adapters/sqlite/tool-repository.js";
import { ToolRegistry } from "../../src/adapters/tools/registry.js";
import { AdvanceRunService } from "../../src/application/advance-run.js";
import { CreateRunService } from "../../src/application/create-run.js";
import { PolicyEngine } from "../../src/application/policy-engine.js";
import { PromptAssembler } from "../../src/application/prompt-assembler.js";
import { CatalogService } from "../../src/config/catalog-service.js";
import { loadCatalog, type CatalogSnapshot } from "../../src/config/catalog-loader.js";
import {
  approvalIdFromUuid,
  attemptIdFromUuid,
  runIdFromUuid,
  sessionIdFromUuid,
  toolCallIdFromUuid,
} from "../../src/domain/ids.js";
import type { JsonValue } from "../../src/domain/json.js";
import type { Run } from "../../src/domain/run.js";
import type { Clock } from "../../src/ports/clock.js";
import type { ModelChunk, ModelPort, ModelRequest } from "../../src/ports/model.js";
import type { RunStore } from "../../src/ports/run-store.js";
import type {
  ToolDefinition,
  ToolPolicyFacts,
  ToolResult,
} from "../../src/ports/tool.js";
import { RunWorker } from "../../src/runtime/run-worker.js";
import { SystemClock } from "../../src/adapters/system-clock.js";
import { FakeIds } from "../helpers/fake-ids.js";
import { FakeTool } from "../helpers/fake-tool.js";
import { noOpProviderHealthSink } from "../helpers/provider-health.js";
import { resolvedAgents } from "../helpers/resolved-agents.js";
import { completedText, ScriptedModel } from "../helpers/scripted-model.js";
import { tempPath } from "../helpers/temp-dir.js";

describe("RunWorker", () => {
  let catalogSnapshot: CatalogSnapshot;

  beforeAll(async () => {
    catalogSnapshot = await loadCatalog(path.resolve("test/fixtures/config/valid/myagent.yaml"));
  });

  it("claims and advances a Run to a durable terminal checkpoint", async () => {
    const connection = openDatabase({ path: tempPath("run-worker.db"), busyTimeoutMs: 5_000 });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const clock = new SystemClock();
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000031")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000031")],
        attemptIds: [attemptIdFromUuid("00000000-0000-7000-8000-000000000031")],
      });
      const created = new CreateRunService(resolvedAgents(new CatalogService(catalogSnapshot)), runs, clock, ids).execute({
        agentId: "primary", sessionKey: "integration:worker", input: { type: "text", text: "hello" },
        idempotencyKey: "run-worker-0001", source: { kind: "http" },
      });
      const model = new ScriptedModel();
      model.script(completedText("worker answer"));
      const advance = new AdvanceRunService({
        runs, tools: new SqliteToolRepository(connection.db), approvals: new SqliteApprovalRepository(connection.db),
        sessions, model, prompts: new PromptAssembler(sessions), registry: new ToolRegistry(),
        policy: new PolicyEngine(), clock, ids, modelRegistry: noOpProviderHealthSink,
      });
      const worker = new RunWorker({ runs, advance, clock, workerId: "worker-integration", concurrency: 1, leaseDurationMs: 1_000, idleDelayMs: 5 });

      worker.start();
      await waitFor(() => runs.getRun(created.runId).state === "completed");
      await worker.stop();

      expect(runs.getRun(created.runId).state).toBe("completed");
      expect(model.requests).toHaveLength(1);
    } finally {
      connection.close();
    }
  });

  it("feeds a completed Tool result into the next model turn", async () => {
    const connection = openDatabase({ path: tempPath("run-worker-tool-loop.db"), busyTimeoutMs: 5_000 });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const clock = new SystemClock();
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000032")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000032")],
        toolCallIds: [toolCallIdFromUuid("00000000-0000-7000-8000-000000000032")],
        attemptIds: [
          attemptIdFromUuid("00000000-0000-7000-8000-000000000032"),
          attemptIdFromUuid("00000000-0000-7000-8000-000000000033"),
        ],
      });
      const created = new CreateRunService(resolvedAgents(new CatalogService(catalogSnapshot)), runs, clock, ids).execute({
        agentId: "primary", sessionKey: "integration:tool-loop", input: { type: "text", text: "read" },
        idempotencyKey: "run-worker-0002", source: { kind: "http" },
      });
      const registry = new ToolRegistry();
      registry.register(new FakeTool({
        name: "read_file", effect: "read_only", normalizedArguments: { path: "report.md" },
        policyFacts: { pathWithinWorkspace: true }, result: {
          ok: true, summary: "contents", content: { contents: "report body" }, capturedBytes: 11, truncated: false,
        },
      }));
      const model = new ScriptedModel();
      model.script({ chunks: [
        {
          type: "tool_call",
          callId: "provider_tool_loop",
          name: "read_file",
          arguments: { path: "report.md" },
        },
        { type: "completed", finishReason: "tool_call", usage: { inputTokens: 10, outputTokens: 2 } },
      ] }, completedText("final after tool"));
      const advance = new AdvanceRunService({
        runs, tools: new SqliteToolRepository(connection.db), approvals: new SqliteApprovalRepository(connection.db),
        sessions, model, prompts: new PromptAssembler(sessions), registry,
        policy: new PolicyEngine(), clock, ids, modelRegistry: noOpProviderHealthSink,
      });
      const worker = new RunWorker({ runs, advance, clock, workerId: "worker-tool", concurrency: 1, leaseDurationMs: 1_000, idleDelayMs: 5 });

      worker.start();
      await waitFor(() => runs.getRun(created.runId).state === "completed");
      await worker.stop();

      expect(model.requests[1]?.input).toContainEqual({
        type: "assistant_tool_call",
        callId: "provider_tool_loop",
        name: "read_file",
        arguments: { path: "report.md" },
      });
      expect(model.requests[1]?.input).toContainEqual({
        type: "tool_result",
        callId: "provider_tool_loop",
        name: "read_file",
        output: expect.objectContaining({ content: { contents: "report body" } }),
      });
    } finally {
      connection.close();
    }
  });

  it("fails an unknown Tool proposal without removing the lane for a later Run", async () => {
    const connection = openDatabase({
      path: tempPath("run-worker-unknown-tool.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const clock = new SystemClock();
      const ids = new FakeIds({
        sessionIds: [
          sessionIdFromUuid("00000000-0000-7000-8000-000000000191"),
          sessionIdFromUuid("00000000-0000-7000-8000-000000000192"),
        ],
        runIds: [
          runIdFromUuid("00000000-0000-7000-8000-000000000191"),
          runIdFromUuid("00000000-0000-7000-8000-000000000192"),
        ],
        attemptIds: [
          attemptIdFromUuid("00000000-0000-7000-8000-000000000191"),
          attemptIdFromUuid("00000000-0000-7000-8000-000000000192"),
        ],
      });
      const create = new CreateRunService(
        resolvedAgents(new CatalogService(catalogSnapshot)),
        runs,
        clock,
        ids,
      );
      const malformed = create.execute({
        agentId: "primary",
        sessionKey: "integration:unknown-tool",
        input: { type: "text", text: "propose the unknown Tool" },
        idempotencyKey: "run-worker-unknown-0001",
        source: { kind: "http" },
      });
      const later = create.execute({
        agentId: "primary",
        sessionKey: "integration:after-unknown-tool",
        input: { type: "text", text: "complete after malformed Run" },
        idempotencyKey: "run-worker-unknown-0002",
        source: { kind: "http" },
      });
      const model = new UnknownToolRoutingModel();
      const advance = new AdvanceRunService({
        runs,
        tools: new SqliteToolRepository(connection.db),
        approvals: new SqliteApprovalRepository(connection.db),
        sessions,
        model,
        prompts: new PromptAssembler(sessions),
        registry: new ToolRegistry(),
        policy: new PolicyEngine(),
        clock,
        ids,
        modelRegistry: noOpProviderHealthSink,
      });
      const worker = new RunWorker({
        runs,
        advance,
        clock,
        workerId: "worker-unknown-tool",
        concurrency: 1,
        leaseDurationMs: 1_000,
        idleDelayMs: 5,
      });

      worker.start();
      try {
        await waitFor(() =>
          runs.getRun(malformed.runId).state === "failed" &&
          runs.getRun(later.runId).state === "completed"
        );
      } finally {
        await worker.stop().catch(() => undefined);
      }

      expect(runs.getUnmatchedModelAttempt(malformed.runId)).toBeNull();
      expect(
        runs.listEventsAfter(malformed.runId, 0).map((event) => [
          event.type,
          event.payload,
        ]),
      ).toEqual(expect.arrayContaining([
        ["model.attempt.failed", expect.objectContaining({ code: "tool_not_found" })],
        ["run.failed", expect.objectContaining({ code: "tool_not_found" })],
      ]));
      expect(
        model.completedInputs.some((input) =>
          input.includes("complete after malformed Run")
        ),
      ).toBe(true);
    } finally {
      connection.close();
    }
  });

  it("reports an unexpected Run failure and keeps the lane available", async () => {
    const firstRunId = runIdFromUuid("00000000-0000-7000-8000-000000000193");
    const laterRunId = runIdFromUuid("00000000-0000-7000-8000-000000000194");
    const claims = [{ runId: firstRunId }, { runId: laterRunId }];
    const runs = {
      claimNextEligible: () => claims.shift() as Run | undefined ?? null,
      renewLease: () => true,
    } as unknown as RunStore;
    const failure = new Error("unexpected_run_failure");
    let laterAdvanced = false;
    const advance = {
      advance: async (runId: typeof firstRunId) => {
        if (runId === firstRunId) throw failure;
        laterAdvanced = true;
        return { type: "terminal", runId, state: "completed" } as const;
      },
      isAbortSafe: () => true,
    } as unknown as AdvanceRunService;
    const reported: Array<{ error: unknown; runId: typeof firstRunId }> = [];
    const worker = new RunWorker({
      runs,
      advance,
      clock: new SystemClock(),
      workerId: "worker-supervised",
      concurrency: 1,
      leaseDurationMs: 1_000,
      idleDelayMs: 5,
      onUnexpectedRunError(error, runId) {
        reported.push({ error, runId });
      },
    });

    worker.start();
    try {
      await waitFor(() => laterAdvanced);
    } finally {
      await worker.stop().catch(() => undefined);
    }

    expect(reported).toEqual([{ error: failure, runId: firstRunId }]);
  });

  it("reports and surfaces a fatal claim failure", async () => {
    const failure = new Error("fatal_claim_failure");
    const runs = {
      claimNextEligible: () => {
        throw failure;
      },
    } as unknown as RunStore;
    let reported: unknown;
    const worker = new RunWorker({
      runs,
      advance: {} as AdvanceRunService,
      clock: new SystemClock(),
      workerId: "worker-fatal-claim",
      concurrency: 1,
      onFatalError(error) {
        reported = error;
      },
    });

    worker.start();
    await waitFor(() => reported !== undefined).catch(() => undefined);

    expect(reported).toBe(failure);
    expect((worker as RunWorker & { isHealthy?: () => boolean }).isHealthy?.())
      .toBe(false);
    await expect(worker.stop()).rejects.toBe(failure);
  });

  it("does not abort an executing side-effect Tool during worker shutdown", async () => {
    const connection = openDatabase({
      path: tempPath("run-worker-side-effect-stop.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const clock = new SystemClock();
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000034")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000034")],
        toolCallIds: [toolCallIdFromUuid("00000000-0000-7000-8000-000000000034")],
        attemptIds: [attemptIdFromUuid("00000000-0000-7000-8000-000000000034")],
      });
      const created = new CreateRunService(
        resolvedAgents(new CatalogService(catalogSnapshot)),
        runs,
        clock,
        ids,
      ).execute({
        agentId: "primary",
        sessionKey: "integration:side-effect-stop",
        input: { type: "text", text: "perform a side effect" },
        idempotencyKey: "run-worker-stop-0001",
        source: { kind: "http" },
      });
      const tool = new PausingTool("side_effect");
      const registry = new ToolRegistry();
      registry.register(tool);
      const model = new ScriptedModel();
      model.script({
        chunks: [
          {
            type: "tool_call",
            callId: "provider_side_effect_stop",
            name: "read_file",
            arguments: { path: "report.md" },
          },
          {
            type: "completed",
            finishReason: "tool_call",
            usage: { inputTokens: 10, outputTokens: 2 },
          },
        ],
      });
      const tools = new SqliteToolRepository(connection.db);
      const advance = new AdvanceRunService({
        runs,
        tools,
        approvals: new SqliteApprovalRepository(connection.db),
        sessions,
        model,
        prompts: new PromptAssembler(sessions),
        registry,
        policy: new PolicyEngine(),
        clock,
        ids,
        modelRegistry: noOpProviderHealthSink,
      });
      const worker = new RunWorker({
        runs,
        advance,
        clock,
        workerId: "worker-stop",
        concurrency: 1,
        leaseDurationMs: 1_000,
        idleDelayMs: 5,
      });

      worker.start();
      await tool.started;
      const stopping = worker.stop();
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      expect(tool.signalAborted).toBe(false);
      tool.complete();
      await stopping;
      expect(tools.getLatestForRun(created.runId)?.state).toBe("succeeded");
      expect(runs.listEventsAfter(created.runId, 0).map((event) => event.type))
        .not.toContain("tool.failed");
    } finally {
      connection.close();
    }
  });

  it("aborts read-only work without persisting shutdown as a Tool failure", async () => {
    const connection = openDatabase({
      path: tempPath("run-worker-read-only-stop.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const clock = new SystemClock();
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000035")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000035")],
        toolCallIds: [toolCallIdFromUuid("00000000-0000-7000-8000-000000000035")],
        attemptIds: [attemptIdFromUuid("00000000-0000-7000-8000-000000000035")],
      });
      const created = new CreateRunService(
        resolvedAgents(new CatalogService(catalogSnapshot)),
        runs,
        clock,
        ids,
      ).execute({
        agentId: "primary",
        sessionKey: "integration:read-only-stop",
        input: { type: "text", text: "perform a read" },
        idempotencyKey: "run-worker-stop-0002",
        source: { kind: "http" },
      });
      const tool = new PausingTool("read_only");
      const registry = new ToolRegistry();
      registry.register(tool);
      const model = new ScriptedModel();
      model.script({
        chunks: [
          {
            type: "tool_call",
            callId: "provider_read_only_stop",
            name: "read_file",
            arguments: { path: "report.md" },
          },
          {
            type: "completed",
            finishReason: "tool_call",
            usage: { inputTokens: 10, outputTokens: 2 },
          },
        ],
      });
      const tools = new SqliteToolRepository(connection.db);
      const advance = new AdvanceRunService({
        runs,
        tools,
        approvals: new SqliteApprovalRepository(connection.db),
        sessions,
        model,
        prompts: new PromptAssembler(sessions),
        registry,
        policy: new PolicyEngine(),
        clock,
        ids,
        modelRegistry: noOpProviderHealthSink,
      });
      const worker = new RunWorker({
        runs,
        advance,
        clock,
        workerId: "worker-read-only-stop",
        concurrency: 1,
        leaseDurationMs: 1_000,
        idleDelayMs: 5,
      });

      worker.start();
      await tool.started;
      await worker.stop();

      expect(tool.signalAborted).toBe(true);
      expect(tools.getLatestForRun(created.runId)?.state).toBe("executing");
      expect(runs.listEventsAfter(created.runId, 0).map((event) => event.type))
        .not.toContain("tool.failed");
    } finally {
      connection.close();
    }
  });

  it("backs off after SQLite busy during advancement", async () => {
    const runId = runIdFromUuid("00000000-0000-7000-8000-000000000036");
    let claims = 0;
    const runs = {
      claimNextEligible: () => {
        claims += 1;
        return claims === 1 ? { runId } as Run : null;
      },
      renewLease: () => true,
    } as unknown as RunStore;
    const busyError = Object.assign(new Error("database is locked"), {
      errcode: 5,
    });
    const advance = {
      advance: async () => {
        throw busyError;
      },
      isAbortSafe: () => true,
    } as unknown as AdvanceRunService;
    const clock = new ControlledWorkerClock();
    const worker = new RunWorker({
      runs,
      advance,
      clock,
      workerId: "worker-busy",
      concurrency: 1,
      leaseDurationMs: 30_000,
      idleDelayMs: 5,
    });

    worker.start();
    await clock.firstSleepRequested;

    expect(clock.delays[0]).toBe(50);
    const stopping = worker.stop();
    clock.releaseSleep();
    await stopping;
  });

  it("aborts safe work and backs off when heartbeat renewal fails", async () => {
    const runId = runIdFromUuid("00000000-0000-7000-8000-000000000037");
    let claims = 0;
    const busyError = Object.assign(new Error("database is locked"), {
      errcode: 5,
    });
    const runs = {
      claimNextEligible: () => {
        claims += 1;
        return claims === 1 ? { runId } as Run : null;
      },
      renewLease: () => {
        throw busyError;
      },
    } as unknown as RunStore;
    let abortReason: unknown;
    const advance = {
      advance: async (
        _runId: unknown,
        _leaseOwner: unknown,
        signal: AbortSignal,
      ) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          abortReason = signal.reason;
          reject(signal.reason);
        }, { once: true });
      }),
      isAbortSafe: () => true,
      finalizeCancellation: () => null,
    } as unknown as AdvanceRunService;
    const clock = new ControlledWorkerClock();
    const worker = new RunWorker({
      runs,
      advance,
      clock,
      workerId: "worker-heartbeat-busy",
      concurrency: 1,
      leaseDurationMs: 3,
      idleDelayMs: 5,
    });

    worker.start();
    try {
      await withTimeout(clock.firstSleepRequested, 200);
      expect(abortReason).toBe(busyError);
      expect(clock.delays[0]).toBe(50);
    } finally {
      const stopping = worker.stop();
      clock.releaseSleep();
      await stopping;
    }
  });

  it("backs off when cancellation finalization encounters SQLite busy", async () => {
    const runId = runIdFromUuid("00000000-0000-7000-8000-000000000038");
    let claims = 0;
    const busyError = Object.assign(new Error("database is locked"), { errcode: 5 });
    const runs = {
      claimNextEligible: () => {
        claims += 1;
        return claims === 1 ? { runId } as Run : null;
      },
      renewLease: () => { throw busyError; },
    } as unknown as RunStore;
    const advance = {
      advance: async (
        _runId: unknown,
        _leaseOwner: unknown,
        signal: AbortSignal,
      ) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
      isAbortSafe: () => true,
      finalizeCancellation: () => { throw busyError; },
    } as unknown as AdvanceRunService;
    const clock = new ControlledWorkerClock();
    const worker = new RunWorker({
      runs,
      advance,
      clock,
      workerId: "worker-cancel-finalize-busy",
      concurrency: 1,
      leaseDurationMs: 3,
      idleDelayMs: 5,
    });

    worker.start();
    try {
      await withTimeout(clock.firstSleepRequested, 200);
      expect(clock.delays[0]).toBe(50);
    } finally {
      const stopping = worker.stop();
      clock.releaseSleep();
      await stopping;
    }
  });

  it("keeps one Session blocked on Approval while another Session completes", async () => {
    const connection = openDatabase({
      path: tempPath("run-worker-session-concurrency.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const clock = new SystemClock();
      const ids = new FakeIds({
        sessionIds: [
          sessionIdFromUuid("00000000-0000-7000-8000-000000000041"),
          sessionIdFromUuid("00000000-0000-7000-8000-000000000042"),
        ],
        runIds: [
          runIdFromUuid("00000000-0000-7000-8000-000000000041"),
          runIdFromUuid("00000000-0000-7000-8000-000000000042"),
          runIdFromUuid("00000000-0000-7000-8000-000000000043"),
        ],
        attemptIds: [
          attemptIdFromUuid("00000000-0000-7000-8000-000000000041"),
          attemptIdFromUuid("00000000-0000-7000-8000-000000000042"),
        ],
        toolCallIds: [
          toolCallIdFromUuid("00000000-0000-7000-8000-000000000041"),
        ],
        approvalIds: [
          approvalIdFromUuid("00000000-0000-7000-8000-000000000041"),
        ],
      });
      const create = new CreateRunService(
        resolvedAgents(new CatalogService(catalogSnapshot)),
        runs,
        clock,
        ids,
      );
      const waiting = create.execute({
        agentId: "primary",
        sessionKey: "integration:blocked",
        input: { type: "text", text: "approval request" },
        idempotencyKey: "run-worker-approval-0001",
        source: { kind: "http" },
      });
      const queued = create.execute({
        agentId: "primary",
        sessionKey: "integration:blocked",
        input: { type: "text", text: "must stay queued" },
        idempotencyKey: "run-worker-approval-0002",
        source: { kind: "http" },
      });
      const independent = create.execute({
        agentId: "primary",
        sessionKey: "integration:independent",
        input: { type: "text", text: "finish independently" },
        idempotencyKey: "run-worker-approval-0003",
        source: { kind: "http" },
      });
      const registry = new ToolRegistry();
      registry.register(new FakeTool({
        name: "run_command",
        effect: "side_effect",
        normalizedArguments: { program: "node", args: [] },
      }));
      const model = new RoutingModel();
      const advance = new AdvanceRunService({
        runs,
        tools: new SqliteToolRepository(connection.db),
        approvals: new SqliteApprovalRepository(connection.db),
        sessions,
        model,
        prompts: new PromptAssembler(sessions),
        registry,
        policy: new PolicyEngine(),
        clock,
        ids,
        modelRegistry: noOpProviderHealthSink,
      });
      const worker = new RunWorker({
        runs,
        advance,
        clock,
        workerId: "worker-concurrency",
        concurrency: 2,
        leaseDurationMs: 1_000,
        idleDelayMs: 5,
      });

      worker.start();
      await waitFor(
        () =>
          runs.getRun(waiting.runId).state === "waiting_approval" &&
          runs.getRun(independent.runId).state === "completed",
      );
      await worker.stop();

      expect(runs.getRun(queued.runId).state).toBe("queued");
      expect(model.operatorInputs).not.toContain("must stay queued");
    } finally {
      connection.close();
    }
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed_out_waiting_for_worker");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

class RoutingModel implements ModelPort {
  readonly operatorInputs: string[] = [];

  async *streamAttempt(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelChunk> {
    signal.throwIfAborted();
    const input = currentOperatorInput(request);
    const text = input.includes("approval request")
      ? "approval request"
      : input.includes("must stay queued")
        ? "must stay queued"
        : "finish independently";
    this.operatorInputs.push(text);
    if (text === "approval request") {
      yield {
        type: "tool_call",
        callId: "provider_approval_request",
        name: "run_command",
        arguments: { program: "node", args: [] },
      };
      yield {
        type: "completed",
        finishReason: "tool_call",
        usage: { inputTokens: 10, outputTokens: 2 },
      };
      return;
    }
    yield { type: "text_delta", text: "independent answer" };
    yield {
      type: "completed",
      finishReason: "completed",
      usage: { inputTokens: 10, outputTokens: 2 },
    };
  }
}

class UnknownToolRoutingModel implements ModelPort {
  readonly completedInputs: string[] = [];

  async *streamAttempt(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelChunk> {
    signal.throwIfAborted();
    const input = currentOperatorInput(request);
    if (input.includes("propose the unknown Tool")) {
      yield {
        type: "tool_call",
        callId: "provider_unknown_tool",
        name: "not_registered",
        arguments: {},
      };
      yield {
        type: "completed",
        finishReason: "tool_call",
        usage: { inputTokens: 10, outputTokens: 2 },
      };
      return;
    }
    this.completedInputs.push(input);
    yield { type: "text_delta", text: "later answer" };
    yield {
      type: "completed",
      finishReason: "completed",
      usage: { inputTokens: 10, outputTokens: 2 },
    };
  }
}

function currentOperatorInput(request: ModelRequest): string {
  for (const entry of request.input) {
    if (entry.type === "message" && entry.name === "current_operator_input") {
      return entry.content;
    }
  }
  return "";
}

class PausingTool implements ToolDefinition {
  readonly name = "read_file";
  readonly effect: ToolDefinition["effect"];
  readonly description = "Pausing side effect";
  readonly inputSchema: JsonValue = { type: "object" };
  readonly started: Promise<void>;
  signalAborted = false;
  private markStarted!: () => void;
  private finish!: (result: ToolResult) => void;

  constructor(effect: ToolDefinition["effect"]) {
    this.effect = effect;
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
  }

  async parseAndNormalize(): Promise<{
    arguments: JsonValue;
    policyFacts: ToolPolicyFacts;
  }> {
    return {
      arguments: { path: "report.md" },
      policyFacts: { pathWithinWorkspace: true },
    };
  }

  async execute(
    _arguments: JsonValue,
    context: Parameters<ToolDefinition["execute"]>[1],
  ): Promise<ToolResult> {
    const completion = new Promise<ToolResult>((resolve, reject) => {
      this.finish = resolve;
      context.signal.addEventListener("abort", () => {
        this.signalAborted = true;
        reject(context.signal.reason);
      }, { once: true });
    });
    this.markStarted();
    return completion;
  }

  complete(): void {
    this.finish({
      ok: true,
      summary: "side effect completed",
      content: { completed: true },
      capturedBytes: 0,
      truncated: false,
    });
  }
}

class ControlledWorkerClock implements Clock {
  readonly delays: number[] = [];
  readonly firstSleepRequested: Promise<void>;
  private markSleepRequested!: () => void;
  private release: (() => void) | undefined;

  constructor() {
    this.firstSleepRequested = new Promise((resolve) => {
      this.markSleepRequested = resolve;
    });
  }

  now(): Date {
    return new Date("2026-08-07T00:00:00.000Z");
  }

  async sleep(milliseconds: number): Promise<void> {
    this.delays.push(milliseconds);
    this.markSleepRequested();
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  releaseSleep(): void {
    this.release?.();
  }
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("timed_out_waiting_for_worker_signal")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
