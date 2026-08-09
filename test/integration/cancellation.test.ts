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
import { SystemClock } from "../../src/adapters/system-clock.js";
import { AdvanceRunService } from "../../src/application/advance-run.js";
import { CancelRunService } from "../../src/application/cancel-run.js";
import { CreateRunService } from "../../src/application/create-run.js";
import { PolicyEngine } from "../../src/application/policy-engine.js";
import { PromptAssembler } from "../../src/application/prompt-assembler.js";
import { CatalogService } from "../../src/config/catalog-service.js";
import { loadCatalog, type CatalogSnapshot } from "../../src/config/catalog-loader.js";
import {
  runIdFromUuid,
  sessionIdFromUuid,
  toolCallIdFromUuid,
} from "../../src/domain/ids.js";
import { ExecutionRegistry } from "../../src/runtime/execution-registry.js";
import { RunWorker } from "../../src/runtime/run-worker.js";
import type { FaultPoint } from "../../src/runtime/fault-injector.js";
import type { ModelChunk, ModelPort, ModelRequest } from "../../src/ports/model.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { FakeIds } from "../helpers/fake-ids.js";
import { resolvedAgents } from "../helpers/resolved-agents.js";
import { completedText, ScriptedModel } from "../helpers/scripted-model.js";
import { tempPath } from "../helpers/temp-dir.js";

describe("Run cancellation", () => {
  let snapshot: CatalogSnapshot;

  beforeAll(async () => {
    snapshot = await loadCatalog(
      path.resolve("test/fixtures/config/valid/myagent.yaml"),
    );
  });

  it("publishes run.cancelled only when a durable running request becomes terminal", async () => {
    const connection = openDatabase({
      path: tempPath("cancel-running.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const tools = new SqliteToolRepository(connection.db);
      const approvals = new SqliteApprovalRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const runId = runIdFromUuid("00000000-0000-7000-8000-000000000501");
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000501")],
        runIds: [runId],
      });
      new CreateRunService(resolvedAgents(new CatalogService(snapshot)), runs, clock, ids).execute({
        agentId: "primary",
        sessionKey: "cancel:running",
        input: { type: "text", text: "cancel before model I/O" },
        idempotencyKey: "cancel-running-0001",
        source: { kind: "http" },
      });
      runs.claimNextEligible(
        "cancel-worker",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const executions = new ExecutionRegistry();
      const controller = new AbortController();
      executions.register(runId, controller);

      new CancelRunService(runs, executions, clock).execute({ runId });

      expect(controller.signal.aborted).toBe(true);
      expect(runs.getRun(runId).state).toBe("running");
      expect(
        runs.listEventsAfter(runId, 0).filter((event) => event.type === "run.cancelled"),
      ).toEqual([]);
      const hookPoints: FaultPoint[] = [];
      const advance = new AdvanceRunService({
        runs,
        tools,
        approvals,
        sessions,
        model: new ScriptedModel(),
        prompts: new PromptAssembler(sessions),
        registry: new ToolRegistry(),
        policy: new PolicyEngine(),
        clock,
        ids: new FakeIds(),
        faults: {
          async hit(point): Promise<void> {
            hookPoints.push(point);
          },
        },
      });

      expect(await advance.finalizeCancellation(runId, "cancel-worker")).toEqual({
        type: "terminal",
        runId,
        state: "cancelled",
      });
      expect(hookPoints).toEqual([]);
      expect(runs.getRun(runId).state).toBe("cancelled");
      expect(
        runs.listEventsAfter(runId, 0).filter((event) => event.type === "run.cancelled"),
      ).toHaveLength(1);
    } finally {
      connection.close();
    }
  });

  it("routes an interrupted side effect to reconciliation instead of cancellation", async () => {
    const connection = openDatabase({
      path: tempPath("cancel-side-effect.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const tools = new SqliteToolRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const runId = runIdFromUuid("00000000-0000-7000-8000-000000000502");
      const toolCallId = toolCallIdFromUuid(
        "00000000-0000-7000-8000-000000000502",
      );
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000502")],
        runIds: [runId],
      });
      new CreateRunService(resolvedAgents(new CatalogService(snapshot)), runs, clock, ids).execute({
        agentId: "primary",
        sessionKey: "cancel:side-effect",
        input: { type: "text", text: "cancel the running command" },
        idempotencyKey: "cancel-side-effect-0001",
        source: { kind: "http" },
      });
      runs.claimNextEligible(
        "cancel-worker",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const occurredAt = clock.now().toISOString();
      connection.db.prepare(
        `INSERT INTO tool_calls (
           tool_call_id, run_id, state, tool_name, effect, arguments_json,
           canonical_arguments, arguments_sha256, policy_effect,
           policy_facts_json, created_at, updated_at
         ) VALUES (?, ?, 'executing', 'run_command', 'side_effect', '{}', '{}',
           'cancel-digest', 'allow', '{}', ?, ?)`,
      ).run(toolCallId, runId, occurredAt, occurredAt);
      const executions = new ExecutionRegistry();
      const controller = new AbortController();
      executions.register(runId, controller);
      new CancelRunService(runs, executions, clock).execute({ runId });
      clock.advanceBy(2_000);
      const advance = new AdvanceRunService({
        runs,
        tools,
        approvals: new SqliteApprovalRepository(connection.db),
        sessions,
        model: new ScriptedModel(),
        prompts: new PromptAssembler(sessions),
        registry: new ToolRegistry(),
        policy: new PolicyEngine(),
        clock,
        ids: new FakeIds(),
      });

      expect(await advance.finalizeCancellation(runId, "cancel-worker")).toEqual({
        type: "waiting",
        runId,
        state: "waiting_reconciliation",
      });
      expect(tools.get(toolCallId).state).toBe("unknown");
      expect(runs.getRun(runId)).toMatchObject({
        state: "waiting_reconciliation",
        budget: { activeExecutionSeconds: 2 },
      });
      expect(runs.listEventsAfter(runId, 0).map((event) => event.type)).toEqual(
        expect.arrayContaining(["tool.unknown", "run.waiting"]),
      );
      expect(
        runs.listEventsAfter(runId, 0).filter((event) => event.type === "run.cancelled"),
      ).toEqual([]);
    } finally {
      connection.close();
    }
  });

  it("fails an interrupted read-only Tool and cancels the Run", async () => {
    const connection = openDatabase({
      path: tempPath("cancel-read-only.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const tools = new SqliteToolRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const runId = runIdFromUuid("00000000-0000-7000-8000-000000000503");
      const toolCallId = toolCallIdFromUuid(
        "00000000-0000-7000-8000-000000000503",
      );
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000503")],
        runIds: [runId],
      });
      new CreateRunService(resolvedAgents(new CatalogService(snapshot)), runs, clock, ids).execute({
        agentId: "primary",
        sessionKey: "cancel:read-only",
        input: { type: "text", text: "cancel the file read" },
        idempotencyKey: "cancel-read-only-0001",
        source: { kind: "http" },
      });
      runs.claimNextEligible(
        "cancel-worker",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const occurredAt = clock.now().toISOString();
      connection.db.prepare(
        `INSERT INTO tool_calls (
           tool_call_id, run_id, state, tool_name, effect, arguments_json,
           canonical_arguments, arguments_sha256, policy_effect,
           policy_facts_json, created_at, updated_at
         ) VALUES (?, ?, 'executing', 'read_file', 'read_only', '{}', '{}',
           'cancel-digest', 'allow', '{}', ?, ?)`,
      ).run(toolCallId, runId, occurredAt, occurredAt);
      new CancelRunService(runs, new ExecutionRegistry(), clock).execute({ runId });
      const advance = new AdvanceRunService({
        runs,
        tools,
        approvals: new SqliteApprovalRepository(connection.db),
        sessions,
        model: new ScriptedModel(),
        prompts: new PromptAssembler(sessions),
        registry: new ToolRegistry(),
        policy: new PolicyEngine(),
        clock,
        ids: new FakeIds(),
      });

      expect(await advance.finalizeCancellation(runId, "cancel-worker")).toEqual({
        type: "terminal",
        runId,
        state: "cancelled",
      });
      expect(tools.get(toolCallId)).toMatchObject({
        state: "failed",
        result: {
          ok: false,
          summary: "run_cancelled",
          content: { code: "run_cancelled" },
        },
      });
      expect(runs.listEventsAfter(runId, 0).map((event) => event.type)).toEqual(
        expect.arrayContaining(["tool.failed", "run.cancelled"]),
      );
    } finally {
      connection.close();
    }
  });

  it("aborts an active model through the worker registry and durably finalizes cancellation", async () => {
    const connection = openDatabase({
      path: tempPath("cancel-active-model.db"),
      busyTimeoutMs: 5_000,
    });
    const executions = new ExecutionRegistry();
    const workerClock = new SystemClock();
    let worker: RunWorker | undefined;
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const tools = new SqliteToolRepository(connection.db);
      const approvals = new SqliteApprovalRepository(connection.db);
      const runId = runIdFromUuid("00000000-0000-7000-8000-000000000504");
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000504")],
        runIds: [runId],
        attemptIds: ["att_00000000-0000-7000-8000-000000000504" as never],
      });
      new CreateRunService(
        resolvedAgents(new CatalogService(snapshot)),
        runs,
        workerClock,
        ids,
      ).execute({
        agentId: "primary",
        sessionKey: "cancel:model",
        input: { type: "text", text: "wait for cancellation" },
        idempotencyKey: "cancel-model-0001",
        source: { kind: "http" },
      });
      const model = new BlockingModel();
      const advance = new AdvanceRunService({
        runs,
        tools,
        approvals,
        sessions,
        model,
        prompts: new PromptAssembler(sessions),
        registry: new ToolRegistry(),
        policy: new PolicyEngine(),
        clock: workerClock,
        ids,
      });
      worker = new RunWorker({
        runs,
        advance,
        clock: workerClock,
        workerId: "cancel-worker",
        concurrency: 1,
        idleDelayMs: 5,
        leaseDurationMs: 3_000,
        executions,
      });
      worker.start();
      await model.waitUntilStarted();

      new CancelRunService(runs, executions, workerClock).execute({ runId });
      await waitFor(() => runs.getRun(runId).state === "cancelled");

      expect(model.aborted).toBe(true);
      expect(
        runs.listEventsAfter(runId, 0).filter(
          (event) => event.type === "model.attempt.failed",
        ),
      ).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ code: "run_cancelled" }),
        }),
      ]);
      expect(runs.getRun(runId).state).toBe("cancelled");
    } finally {
      await worker?.stop();
      connection.close();
    }
  });

  it("lets the worker durably finalize cancellation during a forced Summary", async () => {
    const connection = openDatabase({
      path: tempPath("cancel-active-summary.db"),
      busyTimeoutMs: 5_000,
    });
    const executions = new ExecutionRegistry();
    const workerClock = new SystemClock();
    let worker: RunWorker | undefined;
    try {
      migrate(connection.db);
      const limitedAgents = resolvedAgents(new CatalogService(snapshot), {
        maxInputTokens: 2_000,
      });
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const tools = new SqliteToolRepository(connection.db);
      const approvals = new SqliteApprovalRepository(connection.db);
      const historicalRunId = runIdFromUuid(
        "00000000-0000-7000-8000-000000000509",
      );
      const runId = runIdFromUuid("00000000-0000-7000-8000-000000000510");
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000509")],
        runIds: [historicalRunId, runId],
        attemptIds: ["att_00000000-0000-7000-8000-000000000509" as never],
      });
      const create = new CreateRunService(
        limitedAgents,
        runs,
        workerClock,
        ids,
      );
      const historical = create.execute({
        agentId: "primary",
        sessionKey: "cancel:summary",
        input: { type: "text", text: "old context ".repeat(2_000) },
        idempotencyKey: "cancel-summary-0001",
        source: { kind: "http" },
      });
      connection.db.prepare(
        "UPDATE runs SET state = 'completed' WHERE run_id = ?",
      ).run(historical.runId);
      create.execute({
        agentId: "primary",
        sessionKey: "cancel:summary",
        input: { type: "text", text: "cancel while summarizing" },
        idempotencyKey: "cancel-summary-0002",
        source: { kind: "http" },
      });
      const model = new BlockingModel();
      const advance = new AdvanceRunService({
        runs,
        tools,
        approvals,
        sessions,
        model,
        prompts: new PromptAssembler(sessions),
        registry: new ToolRegistry(),
        policy: new PolicyEngine(),
        clock: workerClock,
        ids,
      });
      worker = new RunWorker({
        runs,
        advance,
        clock: workerClock,
        workerId: "cancel-summary-worker",
        concurrency: 1,
        idleDelayMs: 5,
        leaseDurationMs: 3_000,
        executions,
      });
      worker.start();
      await model.waitUntilStarted();

      new CancelRunService(runs, executions, workerClock).execute({ runId });
      await waitFor(() => {
        const state = runs.getRun(runId).state;
        return state === "cancelled" || state === "failed";
      });

      const events = runs.listEventsAfter(runId, 0);
      expect(model.requests.map((request) => request.purpose))
        .toEqual(["session_summary"]);
      expect(runs.getRun(runId).state).toBe("cancelled");
      expect(events.filter((event) => event.type === "run.failed")).toEqual([]);
      expect(
        events.filter((event) => event.type === "model.attempt.failed"),
      ).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ code: "run_cancelled" }),
        }),
      ]);
      expect(events.filter((event) => event.type === "run.cancelled"))
        .toHaveLength(1);
    } finally {
      await worker?.stop();
      connection.close();
    }
  });

  it("persists a side-effect result that wins the abort race and then cancels", async () => {
    const connection = openDatabase({
      path: tempPath("cancel-known-side-effect.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const tools = new SqliteToolRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const runId = runIdFromUuid("00000000-0000-7000-8000-000000000505");
      const toolCallId = toolCallIdFromUuid(
        "00000000-0000-7000-8000-000000000505",
      );
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000505")],
        runIds: [runId],
      });
      new CreateRunService(resolvedAgents(new CatalogService(snapshot)), runs, clock, ids).execute({
        agentId: "primary",
        sessionKey: "cancel:known-side-effect",
        input: { type: "text", text: "cancel while the command finishes" },
        idempotencyKey: "cancel-known-side-effect-0001",
        source: { kind: "http" },
      });
      runs.claimNextEligible(
        "cancel-worker",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const occurredAt = clock.now().toISOString();
      connection.db.prepare(
        `INSERT INTO tool_calls (
           tool_call_id, run_id, state, tool_name, effect, arguments_json,
           canonical_arguments, arguments_sha256, policy_effect,
           policy_facts_json, created_at, updated_at
         ) VALUES (?, ?, 'allowed', 'run_command', 'side_effect', '{}', '{}',
           'cancel-digest', 'allow', '{}', ?, ?)`,
      ).run(toolCallId, runId, occurredAt, occurredAt);
      let startedResolve!: () => void;
      const started = new Promise<void>((resolve) => { startedResolve = resolve; });
      let finishResolve!: () => void;
      const finish = new Promise<void>((resolve) => { finishResolve = resolve; });
      const registry = new ToolRegistry();
      registry.register({
        name: "run_command",
        effect: "side_effect",
        async parseAndNormalize() {
          return { arguments: {}, policyFacts: {} };
        },
        async execute() {
          startedResolve();
          await finish;
          return {
            ok: true,
            summary: "side effect completed",
            content: { exitCode: 0 },
            capturedBytes: 0,
            truncated: false,
          };
        },
      });
      const advance = new AdvanceRunService({
        runs,
        tools,
        approvals: new SqliteApprovalRepository(connection.db),
        sessions,
        model: new ScriptedModel(),
        prompts: new PromptAssembler(sessions),
        registry,
        policy: new PolicyEngine(),
        clock,
        ids: new FakeIds(),
      });
      const executions = new ExecutionRegistry();
      const controller = new AbortController();
      executions.register(runId, controller);
      const advancing = advance.advance(runId, "cancel-worker", controller.signal);
      await started;

      new CancelRunService(runs, executions, clock).execute({ runId });
      finishResolve();

      expect(await advancing).toEqual({
        type: "terminal",
        runId,
        state: "cancelled",
      });
      expect(tools.get(toolCallId)).toMatchObject({
        state: "succeeded",
        result: { ok: true, content: { exitCode: 0 } },
      });
      expect(runs.getRun(runId).state).toBe("cancelled");
    } finally {
      connection.close();
    }
  });

  it("honors a durable cancellation request before new I/O after lease recovery", async () => {
    const connection = openDatabase({
      path: tempPath("cancel-restart.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const runId = runIdFromUuid("00000000-0000-7000-8000-000000000506");
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000506")],
        runIds: [runId],
        attemptIds: ["att_00000000-0000-7000-8000-000000000506" as never],
      });
      new CreateRunService(resolvedAgents(new CatalogService(snapshot)), runs, clock, ids).execute({
        agentId: "primary",
        sessionKey: "cancel:restart",
        input: { type: "text", text: "do not call the model after restart" },
        idempotencyKey: "cancel-restart-0001",
        source: { kind: "http" },
      });
      runs.claimNextEligible(
        "old-worker",
        clock.now(),
        new Date(clock.now().getTime() + 1),
      );
      new CancelRunService(runs, new ExecutionRegistry(), clock).execute({ runId });
      clock.advanceBy(2_000);
      runs.claimNextEligible(
        "replacement-worker",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const model = new ScriptedModel();
      model.script(completedText("must not be committed"));
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
      });

      expect(await advance.advance(
        runId,
        "replacement-worker",
        new AbortController().signal,
      )).toEqual({ type: "terminal", runId, state: "cancelled" });
      expect(model.requests).toEqual([]);
    } finally {
      connection.close();
    }
  });

  it("discards a model completion that loses the cancellation race", async () => {
    const connection = openDatabase({
      path: tempPath("cancel-model-completion.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const runId = runIdFromUuid("00000000-0000-7000-8000-000000000507");
      const sessionId = sessionIdFromUuid(
        "00000000-0000-7000-8000-000000000507",
      );
      const ids = new FakeIds({
        sessionIds: [sessionId],
        runIds: [runId],
        attemptIds: ["att_00000000-0000-7000-8000-000000000507" as never],
      });
      new CreateRunService(resolvedAgents(new CatalogService(snapshot)), runs, clock, ids).execute({
        agentId: "primary",
        sessionKey: "cancel:model-completion",
        input: { type: "text", text: "discard the late answer" },
        idempotencyKey: "cancel-model-completion-0001",
        source: { kind: "http" },
      });
      runs.claimNextEligible(
        "cancel-worker",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const model = new CompletingAfterAbortModel();
      const faultSnapshots: Array<{
        point: FaultPoint;
        failedAttempts: number;
        runState: string;
      }> = [];
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
        faults: {
          async hit(point): Promise<void> {
            faultSnapshots.push({
              point,
              failedAttempts: runs.listEventsAfter(runId, 0).filter(
                (event) => event.type === "model.attempt.failed",
              ).length,
              runState: runs.getRun(runId).state,
            });
          },
        },
      });
      const controller = new AbortController();
      const advancing = advance.advance(runId, "cancel-worker", controller.signal);
      await model.waitUntilStarted();

      new CancelRunService(runs, new ExecutionRegistry(), clock).execute({ runId });
      model.complete();

      expect(await advancing).toEqual({
        type: "terminal",
        runId,
        state: "cancelled",
      });
      expect(faultSnapshots).toEqual([
        {
          point: "before_model_attempt_commit",
          failedAttempts: 0,
          runState: "running",
        },
        {
          point: "after_model_attempt_commit",
          failedAttempts: 1,
          runState: "cancelled",
        },
      ]);
      expect(
        sessions.listMessagesThroughRun(sessionId, 0).filter(
          (message) => message.role === "assistant",
        ),
      ).toEqual([]);
      expect(
        runs.listEventsAfter(runId, 0).filter(
          (event) => event.type === "model.attempt.failed",
        ),
      ).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ code: "run_cancelled" }),
        }),
      ]);
    } finally {
      connection.close();
    }
  });

  it("does not persist a Tool proposal when cancellation occurs during normalization", async () => {
    const connection = openDatabase({
      path: tempPath("cancel-tool-normalization.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const tools = new SqliteToolRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const runId = runIdFromUuid("00000000-0000-7000-8000-000000000508");
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000508")],
        runIds: [runId],
        toolCallIds: [toolCallIdFromUuid("00000000-0000-7000-8000-000000000508")],
        attemptIds: ["att_00000000-0000-7000-8000-000000000508" as never],
      });
      new CreateRunService(resolvedAgents(new CatalogService(snapshot)), runs, clock, ids).execute({
        agentId: "primary",
        sessionKey: "cancel:normalization",
        input: { type: "text", text: "cancel while validating a tool" },
        idempotencyKey: "cancel-normalization-0001",
        source: { kind: "http" },
      });
      runs.claimNextEligible(
        "cancel-worker",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const registry = new ToolRegistry();
      registry.register({
        name: "read_file",
        effect: "read_only",
        async parseAndNormalize() {
          new CancelRunService(runs, new ExecutionRegistry(), clock).execute({ runId });
          return { arguments: { path: "report.md" }, policyFacts: {} };
        },
        async execute() {
          throw new Error("must_not_execute_after_cancellation");
        },
      });
      const model = new ScriptedModel();
      model.script({
        chunks: [
          {
            type: "tool_call",
            callId: "provider_cancellation_normalization",
            name: "read_file",
            arguments: { path: "report.md" },
          },
          { type: "completed", finishReason: "tool_call", usage: { inputTokens: 1, outputTokens: 1 } },
        ],
      });
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
      });

      expect(await advance.advance(
        runId,
        "cancel-worker",
        new AbortController().signal,
      )).toEqual({ type: "terminal", runId, state: "cancelled" });
      expect(tools.getLatestForRun(runId)).toBeNull();
      expect(runs.listEventsAfter(runId, 0).map((event) => event.type))
        .not.toContain("tool.proposed");
    } finally {
      connection.close();
    }
  });
});

class BlockingModel implements ModelPort {
  aborted = false;
  readonly requests: ModelRequest[] = [];
  private startedResolve!: () => void;
  private readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve;
  });

  waitUntilStarted(): Promise<void> {
    return this.started;
  }

  async *streamAttempt(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelChunk> {
    this.requests.push(request);
    this.startedResolve();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        this.aborted = true;
        reject(signal.reason);
      }, { once: true });
    });
    yield {
      type: "completed",
      finishReason: "completed",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

class CompletingAfterAbortModel implements ModelPort {
  private startedResolve!: () => void;
  private readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve;
  });
  private completeResolve!: () => void;
  private readonly completion = new Promise<void>((resolve) => {
    this.completeResolve = resolve;
  });

  waitUntilStarted(): Promise<void> {
    return this.started;
  }

  complete(): void {
    this.completeResolve();
  }

  async *streamAttempt(): AsyncIterable<ModelChunk> {
    this.startedResolve();
    await this.completion;
    yield { type: "text_delta", text: "late answer" };
    yield {
      type: "completed",
      finishReason: "completed",
      usage: { inputTokens: 10, outputTokens: 2 },
    };
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition_timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
