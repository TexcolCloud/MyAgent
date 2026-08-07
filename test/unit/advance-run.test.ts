import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { SqliteApprovalRepository } from "../../src/adapters/sqlite/approval-repository.js";
import { SqliteCatalogRepository } from "../../src/adapters/sqlite/catalog-repository.js";
import { openDatabase } from "../../src/adapters/sqlite/database.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { SqliteRunRepository } from "../../src/adapters/sqlite/run-repository.js";
import { SqliteSessionRepository } from "../../src/adapters/sqlite/session-repository.js";
import { SqliteToolRepository } from "../../src/adapters/sqlite/tool-repository.js";
import { AdvanceRunService } from "../../src/application/advance-run.js";
import { CreateRunService } from "../../src/application/create-run.js";
import { PolicyEngine } from "../../src/application/policy-engine.js";
import { PromptAssembler } from "../../src/application/prompt-assembler.js";
import { ToolRegistry } from "../../src/adapters/tools/registry.js";
import { loadCatalog, type CatalogSnapshot } from "../../src/config/catalog-loader.js";
import { CatalogService } from "../../src/config/catalog-service.js";
import {
  attemptIdFromUuid,
  approvalIdFromUuid,
  runIdFromUuid,
  sessionIdFromUuid,
  toolCallIdFromUuid,
} from "../../src/domain/ids.js";
import { ModelProviderError } from "../../src/ports/model.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { FakeIds } from "../helpers/fake-ids.js";
import { FakeTool } from "../helpers/fake-tool.js";
import { completedText, ScriptedModel, transientFailureAfter } from "../helpers/scripted-model.js";
import { tempPath } from "../helpers/temp-dir.js";

describe("AdvanceRunService", () => {
  let catalogSnapshot: CatalogSnapshot;

  beforeAll(async () => {
    catalogSnapshot = await loadCatalog(
      path.resolve("test/fixtures/config/valid/myagent.yaml"),
    );
  });

  it("commits only a completed attempt as canonical assistant history", async () => {
    const connection = openDatabase({
      path: tempPath("advance-final-response.db"),
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
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000001")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000001")],
        attemptIds: [
          attemptIdFromUuid("00000000-0000-7000-8000-000000000001"),
          attemptIdFromUuid("00000000-0000-7000-8000-000000000002"),
        ],
      });
      const created = new CreateRunService(
        new CatalogService(catalogSnapshot),
        runs,
        clock,
        ids,
      ).execute({
        agentId: "primary",
        sessionKey: "unit:final-response",
        input: { type: "text", text: "answer once" },
        idempotencyKey: "advance-final-0001",
        source: { kind: "http" },
      });
      clock.advanceBy(1_000);
      expect(runs.claimNextEligible(
        "worker-unit",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      )?.runId).toBe(created.runId);
      const model = new ScriptedModel();
      model.script(
        transientFailureAfter(
          "discard me",
          new ModelProviderError({
            transient: true,
            code: "provider_overloaded",
            status: 503,
          }),
        ),
        completedText("final answer"),
      );
      const service = new AdvanceRunService({
        runs,
        tools,
        approvals,
        sessions,
        model,
        prompts: new PromptAssembler(sessions),
        registry: new ToolRegistry(),
        policy: new PolicyEngine(),
        clock,
        ids,
      });

      const outcome = await service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      );

      expect(outcome).toEqual({
        type: "terminal",
        runId: created.runId,
        state: "completed",
      });
      expect(runs.listEventsAfter(created.runId, 0).map((event) => event.type))
        .toContain("model.attempt.failed");
      expect(
        sessions
          .listMessagesThroughRun(created.sessionId, 0)
          .filter((message) => message.role === "assistant"),
      ).toEqual([expect.objectContaining({ content: "final answer" })]);
    } finally {
      connection.close();
    }
  });

  it("persists a normalized allowed Tool proposal without executing it", async () => {
    const connection = openDatabase({
      path: tempPath("advance-allowed-proposal.db"),
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
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000011")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000011")],
        toolCallIds: [toolCallIdFromUuid("00000000-0000-7000-8000-000000000011")],
        attemptIds: [attemptIdFromUuid("00000000-0000-7000-8000-000000000011")],
      });
      const created = new CreateRunService(
        new CatalogService(catalogSnapshot),
        runs,
        clock,
        ids,
      ).execute({
        agentId: "primary",
        sessionKey: "unit:allowed-proposal",
        input: { type: "text", text: "read the report" },
        idempotencyKey: "advance-tool-0001",
        source: { kind: "http" },
      });
      clock.advanceBy(1_000);
      runs.claimNextEligible(
        "worker-unit",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const fakeTool = new FakeTool({
        name: "read_file",
        effect: "read_only",
        normalizedArguments: { path: "report.md" },
        policyFacts: { pathWithinWorkspace: true },
      });
      const registry = new ToolRegistry();
      registry.register(fakeTool);
      const model = new ScriptedModel();
      model.script({
        chunks: [
          {
            type: "tool_call",
            call: { name: "read_file", arguments: { path: "./report.md" } },
          },
          {
            type: "completed",
            finishReason: "tool_calls",
            usage: { inputTokens: 12, outputTokens: 4 },
          },
        ],
      });
      const service = new AdvanceRunService({
        runs,
        tools,
        approvals,
        sessions,
        model,
        prompts: new PromptAssembler(sessions),
        registry,
        policy: new PolicyEngine(),
        clock,
        ids,
      });

      expect(await service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      )).toEqual({ type: "advanced", runId: created.runId });
      expect(tools.getLatestForRun(created.runId)).toMatchObject({
        state: "allowed",
        toolName: "read_file",
        arguments: { path: "report.md" },
      });
      expect(fakeTool.executions).toBe(0);
      expect(runs.listEventsAfter(created.runId, 0).map((event) => event.type))
        .toEqual(expect.arrayContaining(["tool.proposed", "tool.policy_decided"]));
    } finally {
      connection.close();
    }
  });

  it("executes an already allowed Tool in a separate durable advance", async () => {
    const connection = openDatabase({
      path: tempPath("advance-allowed-execution.db"),
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
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000021")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000021")],
        toolCallIds: [toolCallIdFromUuid("00000000-0000-7000-8000-000000000021")],
        attemptIds: [attemptIdFromUuid("00000000-0000-7000-8000-000000000021")],
      });
      const created = new CreateRunService(
        new CatalogService(catalogSnapshot), runs, clock, ids,
      ).execute({
        agentId: "primary", sessionKey: "unit:allowed-execution",
        input: { type: "text", text: "read the report" },
        idempotencyKey: "advance-tool-0002", source: { kind: "http" },
      });
      clock.advanceBy(1_000);
      runs.claimNextEligible("worker-unit", clock.now(), new Date(clock.now().getTime() + 30_000));
      const fakeTool = new FakeTool({
        name: "read_file", effect: "read_only", normalizedArguments: { path: "report.md" },
        policyFacts: { pathWithinWorkspace: true },
      });
      const registry = new ToolRegistry();
      registry.register(fakeTool);
      const model = new ScriptedModel();
      model.script({ chunks: [
        { type: "tool_call", call: { name: "read_file", arguments: { path: "report.md" } } },
        { type: "completed", finishReason: "tool_calls", usage: { inputTokens: 12, outputTokens: 4 } },
      ] });
      const service = new AdvanceRunService({
        runs, tools, approvals, sessions, model, prompts: new PromptAssembler(sessions),
        registry, policy: new PolicyEngine(), clock, ids,
      });

      await service.advance(created.runId, "worker-unit", new AbortController().signal);
      expect(await service.advance(created.runId, "worker-unit", new AbortController().signal))
        .toEqual({ type: "advanced", runId: created.runId });
      expect(tools.getLatestForRun(created.runId)).toMatchObject({ state: "succeeded" });
      expect(fakeTool.executions).toBe(1);
      expect(runs.listEventsAfter(created.runId, 0).map((event) => event.type))
        .toEqual(expect.arrayContaining(["tool.started", "tool.completed"]));
    } finally {
      connection.close();
    }
  });

  it("creates a pending Approval and releases the Run when policy asks", async () => {
    const connection = openDatabase({ path: tempPath("advance-approval.db"), busyTimeoutMs: 5_000 });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const tools = new SqliteToolRepository(connection.db);
      const approvals = new SqliteApprovalRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000041")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000041")],
        toolCallIds: [toolCallIdFromUuid("00000000-0000-7000-8000-000000000041")],
        approvalIds: [approvalIdFromUuid("00000000-0000-7000-8000-000000000041")],
        attemptIds: [attemptIdFromUuid("00000000-0000-7000-8000-000000000041")],
      });
      const created = new CreateRunService(new CatalogService(catalogSnapshot), runs, clock, ids).execute({
        agentId: "primary", sessionKey: "unit:approval", input: { type: "text", text: "run" },
        idempotencyKey: "advance-approval-0001", source: { kind: "http" },
      });
      clock.advanceBy(1_000);
      runs.claimNextEligible("worker-unit", clock.now(), new Date(clock.now().getTime() + 30_000));
      const registry = new ToolRegistry();
      registry.register(new FakeTool({ name: "run_command", effect: "side_effect", normalizedArguments: { command: "echo hi" } }));
      const model = new ScriptedModel();
      model.script({ chunks: [
        { type: "tool_call", call: { name: "run_command", arguments: { command: "echo hi" } } },
        { type: "completed", finishReason: "tool_calls", usage: { inputTokens: 10, outputTokens: 2 } },
      ] });
      const service = new AdvanceRunService({
        runs, tools, approvals, sessions, model, prompts: new PromptAssembler(sessions), registry,
        policy: new PolicyEngine(), clock, ids,
      });

      expect(await service.advance(created.runId, "worker-unit", new AbortController().signal))
        .toEqual({ type: "waiting", runId: created.runId, state: "waiting_approval" });
      expect(runs.getRun(created.runId).state).toBe("waiting_approval");
      expect(approvals.getPendingForRun(created.runId)?.expiresAt)
        .toEqual(new Date("2026-08-08T00:00:01.000Z"));
      expect(runs.listEventsAfter(created.runId, 0).map((event) => event.type))
        .toEqual(expect.arrayContaining(["approval.required", "run.waiting"]));
    } finally {
      connection.close();
    }
  });
});
