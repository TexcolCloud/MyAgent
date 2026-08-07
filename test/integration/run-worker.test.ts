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
import type { ModelChunk, ModelPort, ModelRequest } from "../../src/ports/model.js";
import { RunWorker } from "../../src/runtime/run-worker.js";
import { SystemClock } from "../../src/adapters/system-clock.js";
import { FakeIds } from "../helpers/fake-ids.js";
import { FakeTool } from "../helpers/fake-tool.js";
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
      const created = new CreateRunService(new CatalogService(catalogSnapshot), runs, clock, ids).execute({
        agentId: "primary", sessionKey: "integration:worker", input: { type: "text", text: "hello" },
        idempotencyKey: "run-worker-0001", source: { kind: "http" },
      });
      const model = new ScriptedModel();
      model.script(completedText("worker answer"));
      const advance = new AdvanceRunService({
        runs, tools: new SqliteToolRepository(connection.db), approvals: new SqliteApprovalRepository(connection.db),
        sessions, model, prompts: new PromptAssembler(sessions), registry: new ToolRegistry(),
        policy: new PolicyEngine(), clock, ids,
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
      const created = new CreateRunService(new CatalogService(catalogSnapshot), runs, clock, ids).execute({
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
        { type: "tool_call", call: { name: "read_file", arguments: { path: "report.md" } } },
        { type: "completed", finishReason: "tool_calls", usage: { inputTokens: 10, outputTokens: 2 } },
      ] }, completedText("final after tool"));
      const advance = new AdvanceRunService({
        runs, tools: new SqliteToolRepository(connection.db), approvals: new SqliteApprovalRepository(connection.db),
        sessions, model, prompts: new PromptAssembler(sessions), registry,
        policy: new PolicyEngine(), clock, ids,
      });
      const worker = new RunWorker({ runs, advance, clock, workerId: "worker-tool", concurrency: 1, leaseDurationMs: 1_000, idleDelayMs: 5 });

      worker.start();
      await waitFor(() => runs.getRun(created.runId).state === "completed");
      await worker.stop();

      expect(model.requests[1]?.messages.find((message) => message.name === "tool_results")?.content)
        .toContain("report body");
    } finally {
      connection.close();
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
        new CatalogService(catalogSnapshot),
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
    const input = request.messages.find(
      (message) => message.name === "current_operator_input",
    )?.content ?? "";
    const text = input.includes("approval request")
      ? "approval request"
      : input.includes("must stay queued")
        ? "must stay queued"
        : "finish independently";
    this.operatorInputs.push(text);
    if (text === "approval request") {
      yield {
        type: "tool_call",
        call: {
          name: "run_command",
          arguments: { program: "node", args: [] },
        },
      };
      yield {
        type: "completed",
        finishReason: "tool_calls",
        usage: { inputTokens: 10, outputTokens: 2 },
      };
      return;
    }
    yield { type: "text_delta", text: "independent answer" };
    yield {
      type: "completed",
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 2 },
    };
  }
}
