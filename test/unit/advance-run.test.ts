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
import { readFileTool } from "../../src/adapters/tools/read-file.js";
import { loadCatalog, type CatalogSnapshot } from "../../src/config/catalog-loader.js";
import type {
  AgentDefinitionRevision,
  AgentResolverPort,
  AgentRevisionSnapshot,
} from "../../src/domain/agent-revision.js";
import {
  attemptIdFromUuid,
  approvalIdFromUuid,
  modelProfileRevisionIdFromUuid,
  providerConnectionRevisionIdFromUuid,
  runIdFromUuid,
  sessionIdFromUuid,
  toolCallIdFromUuid,
} from "../../src/domain/ids.js";
import {
  ModelProviderError,
  type ModelChunk,
  type ModelPort,
  type ModelRequest,
} from "../../src/ports/model.js";
import type { RecordProviderHealthInput } from "../../src/ports/model-registry-store.js";
import type { ToolStore } from "../../src/ports/tool-store.js";
import type { FaultInjector, FaultPoint } from "../../src/runtime/fault-injector.js";
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
        resolvedAgents(catalogSnapshot),
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
      const health: RecordProviderHealthInput[] = [];
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
        modelRegistry: {
          recordProviderHealth(input): void {
            health.push(input);
          },
        },
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
      expect(health).toEqual([
        expect.objectContaining({
          connectionRevisionId: providerConnectionRevisionIdFromUuid(
            "00000000-0000-7000-8000-000000000001",
          ),
          profileRevisionId: modelProfileRevisionIdFromUuid(
            "00000000-0000-7000-8000-000000000001",
          ),
          outcome: "failure",
          code: "provider_overloaded",
          safeStatus: 503,
          traceId: attemptIdFromUuid(
            "00000000-0000-7000-8000-000000000001",
          ),
        }),
        expect.objectContaining({
          outcome: "success",
          traceId: attemptIdFromUuid(
            "00000000-0000-7000-8000-000000000002",
          ),
        }),
      ]);
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
        resolvedAgents(catalogSnapshot),
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
            callId: "call_provider_11",
            name: "read_file",
            arguments: { path: "./report.md" },
          },
          {
            type: "completed",
            finishReason: "tool_call",
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
        providerCallId: "call_provider_11",
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

  it("persists invalid known-Tool arguments as a denial the model can recover from", async () => {
    const connection = openDatabase({
      path: tempPath("advance-invalid-tool-arguments.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const tools = new SqliteToolRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000181")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000181")],
        toolCallIds: [toolCallIdFromUuid("00000000-0000-7000-8000-000000000181")],
        attemptIds: [
          attemptIdFromUuid("00000000-0000-7000-8000-000000000181"),
          attemptIdFromUuid("00000000-0000-7000-8000-000000000182"),
        ],
      });
      const created = new CreateRunService(
        resolvedAgents(catalogSnapshot),
        runs,
        clock,
        ids,
      ).execute({
        agentId: "primary",
        sessionKey: "unit:invalid-tool-arguments",
        input: { type: "text", text: "recover from malformed arguments" },
        idempotencyKey: "advance-invalid-tool-0001",
        source: { kind: "http" },
      });
      clock.advanceBy(1_000);
      runs.claimNextEligible(
        "worker-unit",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const registry = new ToolRegistry();
      registry.register(readFileTool);
      const model = new ScriptedModel();
      model.script(
        {
          chunks: [
            {
              type: "tool_call",
              callId: "call_provider_181",
              name: "read_file",
              arguments: { path: 42 },
            },
            {
              type: "completed",
              finishReason: "tool_call",
              usage: { inputTokens: 10, outputTokens: 2 },
            },
          ],
        },
        completedText("recovered after Tool denial"),
      );
      const service = new AdvanceRunService({
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

      await expect(service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      )).resolves.toMatchObject({ type: "advanced" });
      expect(tools.getLatestForRun(created.runId)).toMatchObject({
        state: "denied",
        toolName: "read_file",
        arguments: { path: 42 },
        result: { ok: false, code: "invalid_tool_arguments" },
      });
      expect(runs.getUnmatchedModelAttempt(created.runId)).toBeNull();

      await expect(service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      )).resolves.toMatchObject({ type: "terminal", state: "completed" });
      expect(
        model.requests[1]?.input.find((entry) => entry.type === "tool_result"),
      ).toMatchObject({
        callId: "call_provider_181",
        name: "read_file",
        output: { code: "invalid_tool_arguments" },
      });
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
        resolvedAgents(catalogSnapshot), runs, clock, ids,
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
        { type: "tool_call", callId: "call_provider_31", name: "read_file", arguments: { path: "report.md" } },
        { type: "completed", finishReason: "tool_call", usage: { inputTokens: 12, outputTokens: 4 } },
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
      const created = new CreateRunService(resolvedAgents(catalogSnapshot), runs, clock, ids).execute({
        agentId: "primary", sessionKey: "unit:approval", input: { type: "text", text: "run" },
        idempotencyKey: "advance-approval-0001", source: { kind: "http" },
      });
      clock.advanceBy(1_000);
      runs.claimNextEligible("worker-unit", clock.now(), new Date(clock.now().getTime() + 30_000));
      const registry = new ToolRegistry();
      registry.register(new FakeTool({ name: "run_command", effect: "side_effect", normalizedArguments: { command: "echo hi" } }));
      const model = new ScriptedModel();
      model.script({ chunks: [
        { type: "tool_call", callId: "call_provider_41", name: "run_command", arguments: { command: "echo hi" } },
        { type: "completed", finishReason: "tool_call", usage: { inputTokens: 10, outputTokens: 2 } },
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

  it("returns a structured denial to the next model turn", async () => {
    const connection = openDatabase({
      path: tempPath("advance-denied-tool.db"),
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
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000061")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000061")],
        toolCallIds: [toolCallIdFromUuid("00000000-0000-7000-8000-000000000061")],
        attemptIds: [
          attemptIdFromUuid("00000000-0000-7000-8000-000000000061"),
          attemptIdFromUuid("00000000-0000-7000-8000-000000000062"),
        ],
      });
      const created = new CreateRunService(
        resolvedAgents(catalogSnapshot),
        runs,
        clock,
        ids,
      ).execute({
        agentId: "primary",
        sessionKey: "unit:denied-tool",
        input: { type: "text", text: "try the denied tool" },
        idempotencyKey: "advance-denied-0001",
        source: { kind: "http" },
      });
      clock.advanceBy(1_000);
      runs.claimNextEligible(
        "worker-unit",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const deniedTool = new FakeTool({
        name: "delete_everything",
        effect: "side_effect",
        normalizedArguments: { confirmed: true },
      });
      const registry = new ToolRegistry();
      registry.register(deniedTool);
      const model = new ScriptedModel();
      model.script(
        {
          chunks: [
            {
              type: "tool_call",
              callId: "call_provider_61",
              name: "delete_everything",
              arguments: { confirmed: true },
            },
            {
              type: "completed",
              finishReason: "tool_call",
              usage: { inputTokens: 10, outputTokens: 2 },
            },
          ],
        },
        completedText("continued after denial"),
      );
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

      await service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      );
      expect(tools.getLatestForRun(created.runId)).toMatchObject({
        state: "denied",
        result: { ok: false, code: "tool_denied", matchedRule: 3 },
      });
      expect(await service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      )).toEqual({
        type: "terminal",
        runId: created.runId,
        state: "completed",
      });
      expect(
        model.requests[1]?.input.find((entry) => entry.type === "tool_result"),
      ).toMatchObject({
        callId: "call_provider_61",
        name: "delete_everything",
        output: { code: "tool_denied" },
      });
      expect(deniedTool.executions).toBe(0);
    } finally {
      connection.close();
    }
  });

  it("counts current active time before starting a model operation", async () => {
    const connection = openDatabase({
      path: tempPath("advance-active-budget.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const snapshot = withLimits(catalogSnapshot, "active-budget", {
        activeExecutionSeconds: 1,
      });
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000071")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000071")],
        attemptIds: [attemptIdFromUuid("00000000-0000-7000-8000-000000000071")],
      });
      const created = new CreateRunService(
        snapshot,
        runs,
        clock,
        ids,
      ).execute({
        agentId: "primary",
        sessionKey: "unit:active-budget",
        input: { type: "text", text: "do not call the model" },
        idempotencyKey: "advance-budget-0001",
        source: { kind: "http" },
      });
      clock.advanceBy(1_000);
      runs.claimNextEligible(
        "worker-unit",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      clock.advanceBy(1_001);
      const model = new ScriptedModel();
      model.script(completedText("too late"));
      const service = new AdvanceRunService({
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

      expect(await service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      )).toEqual({ type: "terminal", runId: created.runId, state: "failed" });
      expect(model.requests).toHaveLength(0);
      expect(runs.listEventsAfter(created.runId, 0).map((event) => event.type))
        .toContain("run.failed");
    } finally {
      connection.close();
    }
  });

  it("fails before Tool I/O when the aggregate output budget is exhausted", async () => {
    const connection = openDatabase({
      path: tempPath("advance-output-budget.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const snapshot = withLimits(catalogSnapshot, "output-budget", {
        maxToolOutputBytes: 1,
        maxRunToolOutputBytes: 1,
      });
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const tools = new SqliteToolRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000081")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000081")],
        toolCallIds: [toolCallIdFromUuid("00000000-0000-7000-8000-000000000081")],
        attemptIds: [attemptIdFromUuid("00000000-0000-7000-8000-000000000081")],
      });
      const created = new CreateRunService(
        snapshot,
        runs,
        clock,
        ids,
      ).execute({
        agentId: "primary",
        sessionKey: "unit:output-budget",
        input: { type: "text", text: "read only if budget remains" },
        idempotencyKey: "advance-budget-0002",
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
            callId: "call_provider_68",
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
      const service = new AdvanceRunService({
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
      await service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      );
      connection.db.prepare(
        "UPDATE runs SET tool_output_bytes = 1 WHERE run_id = ?",
      ).run(created.runId);

      expect(await service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      )).toEqual({ type: "terminal", runId: created.runId, state: "failed" });
      expect(fakeTool.executions).toBe(0);
    } finally {
      connection.close();
    }
  });

  it("persists Tool-call budget exhaustion as a failed Run", async () => {
    const connection = openDatabase({
      path: tempPath("advance-tool-count-budget.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const snapshot = withLimits(catalogSnapshot, "tool-count-budget", {
        toolCalls: 1,
      });
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const tools = new SqliteToolRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000091")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000091")],
        toolCallIds: [toolCallIdFromUuid("00000000-0000-7000-8000-000000000091")],
        attemptIds: [attemptIdFromUuid("00000000-0000-7000-8000-000000000091")],
      });
      const created = new CreateRunService(
        snapshot,
        runs,
        clock,
        ids,
      ).execute({
        agentId: "primary",
        sessionKey: "unit:tool-count-budget",
        input: { type: "text", text: "do not accept another Tool Call" },
        idempotencyKey: "advance-budget-0003",
        source: { kind: "http" },
      });
      clock.advanceBy(1_000);
      runs.claimNextEligible(
        "worker-unit",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      connection.db.prepare(
        "UPDATE runs SET tool_call_count = 1 WHERE run_id = ?",
      ).run(created.runId);
      const crash = new Error("simulated_crash_after_terminal_attempt_commit");
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
            callId: "call_provider_76",
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
      const service = new AdvanceRunService({
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
        faults: {
          async hit(point): Promise<void> {
            if (point === "after_model_attempt_commit") throw crash;
          },
        },
      });

      await expect(service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      )).rejects.toBe(crash);
      expect(runs.getRun(created.runId).state).toBe("failed");
      expect(runs.listEventsAfter(created.runId, 0).map((event) => event.type))
        .toEqual(expect.arrayContaining(["model.attempt.failed", "run.failed"]));
      expect(tools.getLatestForRun(created.runId)).toBeNull();
      expect(fakeTool.executions).toBe(0);
    } finally {
      connection.close();
    }
  });

  it("persists post-execution Tool output overflow as a failed Run", async () => {
    const connection = openDatabase({
      path: tempPath("advance-tool-output-overflow.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const snapshot = withLimits(catalogSnapshot, "tool-output-overflow", {
        maxToolOutputBytes: 4,
      });
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const tools = new SqliteToolRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000092")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000092")],
        toolCallIds: [toolCallIdFromUuid("00000000-0000-7000-8000-000000000092")],
        attemptIds: [attemptIdFromUuid("00000000-0000-7000-8000-000000000092")],
      });
      const created = new CreateRunService(
        snapshot,
        runs,
        clock,
        ids,
      ).execute({
        agentId: "primary",
        sessionKey: "unit:tool-output-overflow",
        input: { type: "text", text: "read an oversized result" },
        idempotencyKey: "advance-budget-0004",
        source: { kind: "http" },
      });
      clock.advanceBy(1_000);
      runs.claimNextEligible(
        "worker-unit",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const registry = new ToolRegistry();
      registry.register(new FakeTool({
        name: "read_file",
        effect: "read_only",
        normalizedArguments: { path: "report.md" },
        policyFacts: { pathWithinWorkspace: true },
        result: {
          ok: true,
          summary: "oversized",
          content: { contents: "12345" },
          capturedBytes: 5,
          truncated: false,
        },
      }));
      const model = new ScriptedModel();
      model.script({
        chunks: [
          {
            type: "tool_call",
            callId: "call_provider_86",
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
      const service = new AdvanceRunService({
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

      await service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      );
      expect(await service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      )).toEqual({ type: "terminal", runId: created.runId, state: "failed" });
      expect(runs.getRun(created.runId).state).toBe("failed");
      expect(tools.getLatestForRun(created.runId)).toMatchObject({
        state: "failed",
        result: expect.objectContaining({
          ok: false,
          summary: "run_budget_exceeded",
        }),
      });
      expect(runs.listEventsAfter(created.runId, 0)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "tool.failed" }),
        expect.objectContaining({
          type: "run.failed",
          payload: { code: "run_budget_exceeded" },
        }),
      ]));
    } finally {
      connection.close();
    }
  });

  it("does not persist Tool exception details", async () => {
    const connection = openDatabase({
      path: tempPath("advance-tool-error-redaction.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const tools = new SqliteToolRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000093")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000093")],
        toolCallIds: [toolCallIdFromUuid("00000000-0000-7000-8000-000000000093")],
        attemptIds: [attemptIdFromUuid("00000000-0000-7000-8000-000000000093")],
      });
      const created = new CreateRunService(
        resolvedAgents(catalogSnapshot),
        runs,
        clock,
        ids,
      ).execute({
        agentId: "primary",
        sessionKey: "unit:tool-error-redaction",
        input: { type: "text", text: "run a failing Tool" },
        idempotencyKey: "advance-tool-error-0001",
        source: { kind: "http" },
      });
      clock.advanceBy(1_000);
      runs.claimNextEligible(
        "worker-unit",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const secret = "resolved-secret-value";
      const registry = new ToolRegistry();
      registry.register(new FakeTool({
        name: "read_file",
        effect: "read_only",
        normalizedArguments: { path: "report.md" },
        policyFacts: { pathWithinWorkspace: true },
        error: new Error(`adapter failed with ${secret}`),
      }));
      const model = new ScriptedModel();
      model.script({
        chunks: [
          {
            type: "tool_call",
            callId: "call_provider_96",
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
      const service = new AdvanceRunService({
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

      await service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      );
      await service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      );

      expect(tools.getLatestForRun(created.runId)).toMatchObject({
        state: "failed",
        result: {
          ok: false,
          summary: "tool_execution_failed",
          content: { code: "tool_execution_failed" },
          capturedBytes: 0,
          truncated: false,
        },
      });
      expect(JSON.stringify({
        tool: tools.getLatestForRun(created.runId),
        events: runs.listEventsAfter(created.runId, 0),
      })).not.toContain(secret);
    } finally {
      connection.close();
    }
  });

  it.each([
    {
      startState: "never_started" as const,
      expectedToolState: "failed",
      expectedRunState: "running",
      expectedOutcome: "advanced",
      expectedEvent: "tool.failed",
      id: "194",
    },
    {
      startState: "possibly_started" as const,
      expectedToolState: "unknown",
      expectedRunState: "waiting_reconciliation",
      expectedOutcome: "waiting",
      expectedEvent: "tool.unknown",
      id: "195",
    },
  ])(
    "persists a $startState command infrastructure failure without retrying it",
    async ({
      startState,
      expectedToolState,
      expectedRunState,
      expectedOutcome,
      expectedEvent,
      id,
    }) => {
      const connection = openDatabase({
        path: tempPath(`advance-command-${startState}.db`),
        busyTimeoutMs: 5_000,
      });
      try {
        migrate(connection.db);
        const catalog = new SqliteCatalogRepository(connection.db);
        const runs = new SqliteRunRepository(connection.db, catalog);
        const sessions = new SqliteSessionRepository(connection.db);
        const tools = new SqliteToolRepository(connection.db);
        const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
        const uuid = `00000000-0000-7000-8000-000000000${id}`;
        const ids = new FakeIds({
          sessionIds: [sessionIdFromUuid(uuid)],
          runIds: [runIdFromUuid(uuid)],
          toolCallIds: [toolCallIdFromUuid(uuid)],
          attemptIds: [attemptIdFromUuid(uuid)],
        });
        const created = new CreateRunService(
          resolvedAgents(catalogSnapshot),
          runs,
          clock,
          ids,
        ).execute({
          agentId: "primary",
          sessionKey: `unit:command-${startState}`,
          input: { type: "text", text: "run command boundary" },
          idempotencyKey: `advance-command-${startState}-0001`,
          source: { kind: "http" },
        });
        clock.advanceBy(1_000);
        runs.claimNextEligible(
          "worker-unit",
          clock.now(),
          new Date(clock.now().getTime() + 30_000),
        );
        const registry = new ToolRegistry();
        registry.register(new FakeTool({
          name: "read_file",
          effect: "side_effect",
          normalizedArguments: { path: "report.md" },
          policyFacts: { pathWithinWorkspace: true },
          error: Object.assign(
            new Error("tool_execution_infrastructure_failed"),
            {
              code: "tool_execution_infrastructure_failed" as const,
              startState,
            },
          ),
        }));
        const model = new ScriptedModel();
        model.script({
          chunks: [
            {
              type: "tool_call",
              callId: `call_provider_${startState}`,
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
        const service = new AdvanceRunService({
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

        await service.advance(
          created.runId,
          "worker-unit",
          new AbortController().signal,
        );
        const outcome = await service.advance(
          created.runId,
          "worker-unit",
          new AbortController().signal,
        );

        expect(outcome.type).toBe(expectedOutcome);
        expect(tools.getLatestForRun(created.runId)?.state)
          .toBe(expectedToolState);
        expect(runs.getRun(created.runId).state).toBe(expectedRunState);
        expect(
          runs.listEventsAfter(created.runId, 0).map((event) => event.type),
        ).toContain(expectedEvent);
      } finally {
        connection.close();
      }
    },
  );

  it("commits Skill activation with the Tool completion checkpoint", async () => {
    const connection = openDatabase({
      path: tempPath("advance-skill-activation.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const tools = new SqliteToolRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000101")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000101")],
        toolCallIds: [toolCallIdFromUuid("00000000-0000-7000-8000-000000000101")],
        attemptIds: [attemptIdFromUuid("00000000-0000-7000-8000-000000000101")],
      });
      const created = new CreateRunService(
        resolvedAgents(catalogSnapshot),
        runs,
        clock,
        ids,
      ).execute({
        agentId: "primary",
        sessionKey: "unit:skill-activation",
        input: { type: "text", text: "activate research" },
        idempotencyKey: "advance-skill-0001",
        source: { kind: "http" },
      });
      clock.advanceBy(1_000);
      runs.claimNextEligible(
        "worker-unit",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const registry = new ToolRegistry();
      registry.register(new FakeTool({
        name: "activate_skill",
        effect: "internal",
        normalizedArguments: { skillName: "research" },
        activateSkill: "research",
      }));
      const model = new ScriptedModel();
      model.script({
        chunks: [
          {
            type: "tool_call",
            callId: "call_provider_119",
            name: "activate_skill",
            arguments: { skillName: "research" },
          },
          {
            type: "completed",
            finishReason: "tool_call",
            usage: { inputTokens: 10, outputTokens: 2 },
          },
        ],
      });
      const service = new AdvanceRunService({
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

      await service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      );
      await service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      );

      expect(runs.listActivatedSkillNames(created.runId)).toEqual(["research"]);
      expect(runs.listEventsAfter(created.runId, 0).map((event) => event.type))
        .toContain("skill.activated");
    } finally {
      connection.close();
    }
  });

  it("does not persist Skill activation before Tool completion commits", async () => {
    const connection = openDatabase({
      path: tempPath("advance-skill-atomicity.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const durableTools = new SqliteToolRepository(connection.db);
      const tools: ToolStore = {
        getLatestForRun: (runId) => durableTools.getLatestForRun(runId),
        listForRun: (runId) => durableTools.listForRun(runId),
        recordProposal: (input) => durableTools.recordProposal(input),
        beginExecution: (input) => durableTools.beginExecution(input),
        completeExecution: () => {
          throw new Error("injected_completion_failure");
        },
        markExecutionUnknown: (input) =>
          durableTools.markExecutionUnknown(input),
        recoverExecuting: (input) => durableTools.recoverExecuting(input),
      };
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000111")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000111")],
        toolCallIds: [toolCallIdFromUuid("00000000-0000-7000-8000-000000000111")],
        attemptIds: [attemptIdFromUuid("00000000-0000-7000-8000-000000000111")],
      });
      const created = new CreateRunService(
        resolvedAgents(catalogSnapshot),
        runs,
        clock,
        ids,
      ).execute({
        agentId: "primary",
        sessionKey: "unit:skill-atomicity",
        input: { type: "text", text: "activate research" },
        idempotencyKey: "advance-skill-0002",
        source: { kind: "http" },
      });
      clock.advanceBy(1_000);
      runs.claimNextEligible(
        "worker-unit",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const registry = new ToolRegistry();
      registry.register(new FakeTool({
        name: "activate_skill",
        effect: "internal",
        normalizedArguments: { skillName: "research" },
        activateSkill: "research",
      }));
      const model = new ScriptedModel();
      model.script({
        chunks: [
          {
            type: "tool_call",
            callId: "call_provider_130",
            name: "activate_skill",
            arguments: { skillName: "research" },
          },
          {
            type: "completed",
            finishReason: "tool_call",
            usage: { inputTokens: 10, outputTokens: 2 },
          },
        ],
      });
      const service = new AdvanceRunService({
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
      await service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      );

      await expect(service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      )).rejects.toThrow("injected_completion_failure");
      expect(runs.listActivatedSkillNames(created.runId)).toEqual([]);
      expect(runs.listEventsAfter(created.runId, 0).map((event) => event.type))
        .not.toContain("skill.activated");
    } finally {
      connection.close();
    }
  });

  it("flushes a pending model delta within 100 ms without another chunk", async () => {
    const connection = openDatabase({
      path: tempPath("advance-delta-timer.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000121")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000121")],
        attemptIds: [attemptIdFromUuid("00000000-0000-7000-8000-000000000121")],
      });
      const created = new CreateRunService(
        resolvedAgents(catalogSnapshot),
        runs,
        clock,
        ids,
      ).execute({
        agentId: "primary",
        sessionKey: "unit:delta-timer",
        input: { type: "text", text: "stream slowly" },
        idempotencyKey: "advance-delta-0001",
        source: { kind: "http" },
      });
      clock.advanceBy(1_000);
      runs.claimNextEligible(
        "worker-unit",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const model = new PausedCompletionModel();
      const service = new AdvanceRunService({
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

      const advancing = service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      );
      await model.deltaYielded;
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      const deltasBeforeCompletion = runs
        .listEventsAfter(created.runId, 0)
        .filter((event) => event.type === "message.delta");
      model.releaseCompletion();
      await advancing;

      expect(deltasBeforeCompletion).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ text: "first chunk" }),
        }),
      ]);
    } finally {
      connection.close();
    }
  });

  it("checkpoints Summary retries and charges one model turn", async () => {
    const connection = openDatabase({
      path: tempPath("advance-summary-checkpoints.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const snapshot = withModelInputLimit(catalogSnapshot, 2_000);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000131")],
        runIds: [
          runIdFromUuid("00000000-0000-7000-8000-000000000131"),
          runIdFromUuid("00000000-0000-7000-8000-000000000132"),
        ],
        attemptIds: [
          attemptIdFromUuid("00000000-0000-7000-8000-000000000131"),
          attemptIdFromUuid("00000000-0000-7000-8000-000000000132"),
          attemptIdFromUuid("00000000-0000-7000-8000-000000000133"),
        ],
      });
      const create = new CreateRunService(
        snapshot,
        runs,
        clock,
        ids,
      );
      const historical = create.execute({
        agentId: "primary",
        sessionKey: "unit:summary-checkpoints",
        input: { type: "text", text: "old context ".repeat(2_000) },
        idempotencyKey: "advance-summary-0001",
        source: { kind: "http" },
      });
      connection.db.prepare(
        "UPDATE runs SET state = 'completed' WHERE run_id = ?",
      ).run(historical.runId);
      const created = create.execute({
        agentId: "primary",
        sessionKey: "unit:summary-checkpoints",
        input: { type: "text", text: "answer with compact context" },
        idempotencyKey: "advance-summary-0002",
        source: { kind: "http" },
      });
      clock.advanceBy(1_000);
      runs.claimNextEligible(
        "worker-unit",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const model = new ScriptedModel();
      model.script(
        {
          chunks: [],
          error: new ModelProviderError({
            transient: true,
            code: "provider_overloaded",
            status: 503,
          }),
        },
        completedText("durable compact summary"),
        completedText("final answer after summary"),
      );
      const faultSnapshots: Array<{
        point: FaultPoint;
        failedAttempts: number;
        summary: string | null;
      }> = [];
      const faults: FaultInjector = {
        async hit(point): Promise<void> {
          faultSnapshots.push({
            point,
            failedAttempts: runs.listEventsAfter(created.runId, 0)
              .filter((event) => event.type === "model.attempt.failed").length,
            summary: sessions.getCurrentSummary(created.sessionId)?.content ?? null,
          });
        },
      };
      const service = new AdvanceRunService({
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
        faults,
      });

      expect(await service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      )).toEqual({
        type: "advanced",
        runId: created.runId,
      });

      expect(model.requests.map((request) => request.purpose)).toEqual([
        "session_summary",
        "session_summary",
      ]);
      expect(runs.getRun(created.runId).budget.modelTurns).toBe(1);
      expect(sessions.getCurrentSummary(created.sessionId)).toMatchObject({
        content: "durable compact summary",
      });
      expect(faultSnapshots).toEqual([
        { point: "before_model_attempt_commit", failedAttempts: 0, summary: null },
        { point: "after_model_attempt_commit", failedAttempts: 1, summary: null },
        { point: "before_model_attempt_commit", failedAttempts: 1, summary: null },
        {
          point: "after_model_attempt_commit",
          failedAttempts: 1,
          summary: "durable compact summary",
        },
      ]);
      expect(await service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      )).toEqual({ type: "terminal", runId: created.runId, state: "completed" });
      expect(model.requests.map((request) => request.purpose)).toEqual([
        "session_summary", "session_summary", "run",
      ]);
      expect(runs.getRun(created.runId).budget.modelTurns).toBe(2);
      const eventTypes = runs
        .listEventsAfter(created.runId, 0)
        .map((event) => event.type);
      expect(eventTypes.filter((type) => type === "model.attempt.started"))
        .toHaveLength(3);
      expect(eventTypes.filter((type) => type === "model.attempt.failed"))
        .toHaveLength(1);
    } finally {
      connection.close();
    }
  });

  it("does not reclassify a proposal checkpoint failure as a provider failure", async () => {
    const connection = openDatabase({
      path: tempPath("advance-proposal-checkpoint-busy.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const durableTools = new SqliteToolRepository(connection.db);
      const busyError = Object.assign(new Error("database is locked"), {
        errcode: 5,
      });
      const tools: ToolStore = {
        getLatestForRun: (runId) => durableTools.getLatestForRun(runId),
        listForRun: (runId) => durableTools.listForRun(runId),
        recordProposal: () => {
          throw busyError;
        },
        beginExecution: (input) => durableTools.beginExecution(input),
        completeExecution: (input) => durableTools.completeExecution(input),
        markExecutionUnknown: (input) => durableTools.markExecutionUnknown(input),
        recoverExecuting: (input) => durableTools.recoverExecuting(input),
      };
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000151")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000151")],
        toolCallIds: [toolCallIdFromUuid("00000000-0000-7000-8000-000000000151")],
        attemptIds: [attemptIdFromUuid("00000000-0000-7000-8000-000000000151")],
      });
      const created = new CreateRunService(
        resolvedAgents(catalogSnapshot),
        runs,
        clock,
        ids,
      ).execute({
        agentId: "primary",
        sessionKey: "unit:proposal-checkpoint-busy",
        input: { type: "text", text: "propose a Tool" },
        idempotencyKey: "advance-proposal-busy-0001",
        source: { kind: "http" },
      });
      clock.advanceBy(1_000);
      runs.claimNextEligible(
        "worker-unit",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const registry = new ToolRegistry();
      registry.register(new FakeTool({
        name: "read_file",
        effect: "read_only",
        normalizedArguments: { path: "report.md" },
        policyFacts: { pathWithinWorkspace: true },
      }));
      const model = new ScriptedModel();
      model.script({
        chunks: [
          {
            type: "tool_call",
            callId: "call_provider_161",
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
      const service = new AdvanceRunService({
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

      await expect(service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      )).rejects.toBe(busyError);
      expect(runs.getRun(created.runId).state).toBe("running");
      expect(runs.listEventsAfter(created.runId, 0).map((event) => event.type))
        .not.toContain("run.failed");
    } finally {
      connection.close();
    }
  });

  it("atomically fails the Run when transient provider retries are exhausted", async () => {
    const connection = openDatabase({
      path: tempPath("advance-provider-retries-exhausted.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000142")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000142")],
        attemptIds: [
          attemptIdFromUuid("00000000-0000-7000-8000-000000000142"),
          attemptIdFromUuid("00000000-0000-7000-8000-000000000143"),
          attemptIdFromUuid("00000000-0000-7000-8000-000000000144"),
        ],
      });
      const created = new CreateRunService(
        resolvedAgents(catalogSnapshot),
        runs,
        clock,
        ids,
      ).execute({
        agentId: "primary",
        sessionKey: "unit:provider-retries-exhausted",
        input: { type: "text", text: "fail after bounded retries" },
        idempotencyKey: "advance-provider-0002",
        source: { kind: "http" },
      });
      clock.advanceBy(1_000);
      runs.claimNextEligible(
        "worker-unit",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const model = new ScriptedModel();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        model.script({
          chunks: [],
          error: new ModelProviderError({
            transient: true,
            code: "provider_overloaded",
            status: 503,
          }),
        });
      }
      const crash = new Error("simulated_crash_after_terminal_attempt_commit");
      let completedAttemptCommits = 0;
      const service = new AdvanceRunService({
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
            if (point !== "after_model_attempt_commit") return;
            completedAttemptCommits += 1;
            if (completedAttemptCommits === 3) throw crash;
          },
        },
      });

      await expect(service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      )).rejects.toBe(crash);
      expect(model.requests).toHaveLength(3);
      expect(runs.getRun(created.runId).state).toBe("failed");
      const eventTypes = runs.listEventsAfter(created.runId, 0)
        .map((event) => event.type);
      expect(eventTypes.filter((type) => type === "model.attempt.started"))
        .toHaveLength(3);
      expect(eventTypes.filter((type) => type === "model.attempt.failed"))
        .toHaveLength(3);
      expect(eventTypes.filter((type) => type === "run.failed")).toHaveLength(1);
    } finally {
      connection.close();
    }
  });

  it("atomically fails the Run when a Summary attempt terminates", async () => {
    const connection = openDatabase({
      path: tempPath("advance-summary-terminal-failure.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const snapshot = withModelInputLimit(catalogSnapshot, 2_000);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000145")],
        runIds: [
          runIdFromUuid("00000000-0000-7000-8000-000000000145"),
          runIdFromUuid("00000000-0000-7000-8000-000000000146"),
        ],
        attemptIds: [attemptIdFromUuid("00000000-0000-7000-8000-000000000145")],
      });
      const create = new CreateRunService(
        snapshot,
        runs,
        clock,
        ids,
      );
      const historical = create.execute({
        agentId: "primary",
        sessionKey: "unit:summary-terminal-failure",
        input: { type: "text", text: "old context ".repeat(2_000) },
        idempotencyKey: "advance-summary-terminal-0001",
        source: { kind: "http" },
      });
      connection.db.prepare(
        "UPDATE runs SET state = 'completed' WHERE run_id = ?",
      ).run(historical.runId);
      const created = create.execute({
        agentId: "primary",
        sessionKey: "unit:summary-terminal-failure",
        input: { type: "text", text: "summarize or fail durably" },
        idempotencyKey: "advance-summary-terminal-0002",
        source: { kind: "http" },
      });
      clock.advanceBy(1_000);
      runs.claimNextEligible(
        "worker-unit",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const model = new ScriptedModel();
      model.script({
        chunks: [],
        error: new ModelProviderError({
          transient: false,
          code: "provider_request_invalid",
          status: 400,
        }),
      });
      const crash = new Error("simulated_crash_after_terminal_attempt_commit");
      const service = new AdvanceRunService({
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
            if (point === "after_model_attempt_commit") throw crash;
          },
        },
      });

      await expect(service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      )).rejects.toBe(crash);
      expect(model.requests.map((request) => request.purpose))
        .toEqual(["session_summary"]);
      expect(runs.getRun(created.runId).state).toBe("failed");
      expect(sessions.getCurrentSummary(created.sessionId)).toBeNull();
      expect(runs.listEventsAfter(created.runId, 0).map((event) => event.type))
        .toEqual(expect.arrayContaining(["model.attempt.failed", "run.failed"]));
    } finally {
      connection.close();
    }
  });

  it("persists a permanent provider failure as a failed Run", async () => {
    const connection = openDatabase({
      path: tempPath("advance-provider-failure.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000141")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000141")],
        attemptIds: [attemptIdFromUuid("00000000-0000-7000-8000-000000000141")],
      });
      const created = new CreateRunService(
        resolvedAgents(catalogSnapshot),
        runs,
        clock,
        ids,
      ).execute({
        agentId: "primary",
        sessionKey: "unit:provider-failure",
        input: { type: "text", text: "fail durably" },
        idempotencyKey: "advance-provider-0001",
        source: { kind: "http" },
      });
      clock.advanceBy(1_000);
      runs.claimNextEligible(
        "worker-unit",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const model = new ScriptedModel();
      model.script({
        chunks: [],
        error: new ModelProviderError({
          transient: false,
          code: "provider_request_invalid",
          status: 400,
        }),
      });
      const crash = new Error("simulated_crash_after_terminal_attempt_commit");
      const service = new AdvanceRunService({
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
            if (point === "after_model_attempt_commit") throw crash;
          },
        },
      });

      await expect(service.advance(
        created.runId,
        "worker-unit",
        new AbortController().signal,
      )).rejects.toBe(crash);
      expect(model.requests).toHaveLength(1);
      expect(runs.getRun(created.runId).state).toBe("failed");
      expect(runs.listEventsAfter(created.runId, 0).map((event) => event.type))
        .toEqual(expect.arrayContaining(["model.attempt.failed", "run.failed"]));
      expect(
        sessions
          .listMessagesThroughRun(created.sessionId, 0)
          .filter((message) => message.role === "assistant"),
      ).toEqual([]);
    } finally {
      connection.close();
    }
  });
});

function withLimits(
  snapshot: CatalogSnapshot,
  revisionId: string,
  limits: Partial<AgentRevisionSnapshot["limits"]>,
): Pick<AgentResolverPort, "resolve"> {
  return resolvedAgents(snapshot, (revision) => ({
      ...revision,
      revisionId: `rev_${revisionId}`,
      limits: { ...revision.limits, ...limits },
  }));
}

function withModelInputLimit(
  snapshot: CatalogSnapshot,
  maxInputTokens: number,
): Pick<AgentResolverPort, "resolve"> {
  return resolvedAgents(snapshot, (revision) => ({
      ...revision,
      revisionId: `rev_model_input_${String(maxInputTokens)}`,
      model: { ...revision.model, maxInputTokens },
  }));
}

function resolvedAgents(
  snapshot: CatalogSnapshot,
  transform: (revision: AgentRevisionSnapshot) => AgentRevisionSnapshot =
    (revision) => revision,
): Pick<AgentResolverPort, "resolve"> {
  const revisions = new Map(snapshot.available.map(({ id, definition }) => [
    id,
    transform(resolvedRevision(definition)),
  ]));
  return {
    resolve(agentId) {
      const revision = revisions.get(agentId);
      if (revision === undefined) throw new Error("agent_unavailable");
      return revision;
    },
  };
}

function resolvedRevision(
  definition: AgentDefinitionRevision,
): AgentRevisionSnapshot {
  return {
    ...definition,
    revisionId: `rev_${definition.agentId}`,
    definitionRevisionId: definition.definitionRevisionId,
    modelProfileRevisionId: modelProfileRevisionIdFromUuid(
      "00000000-0000-7000-8000-000000000001",
    ),
    model: {
      providerConnectionRevisionId: providerConnectionRevisionIdFromUuid(
        "00000000-0000-7000-8000-000000000001",
      ),
      providerKind: "openai_compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      providerAuth: {
        type: "bearer",
        secret: { fromEnvironment: "MODEL_API_KEY" },
      },
      modelId: "test-model",
      invocationProtocol: "chat_completions",
      maxInputTokens: 32_768,
      verifiedCapabilities: ["streaming_text", "single_tool_call"],
      compatibilityPresetVersion: "test-v1",
    },
    contentSha256: definition.contentSha256,
  };
}

class PausedCompletionModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  readonly deltaYielded: Promise<void>;
  private resolveDeltaYielded!: () => void;
  private readonly completionGate: Promise<void>;
  private resolveCompletion!: () => void;

  constructor() {
    this.deltaYielded = new Promise((resolve) => {
      this.resolveDeltaYielded = resolve;
    });
    this.completionGate = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  releaseCompletion(): void {
    this.resolveCompletion();
  }

  async *streamAttempt(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelChunk> {
    signal.throwIfAborted();
    this.requests.push(request);
    yield { type: "text_delta", text: "first chunk" };
    this.resolveDeltaYielded();
    await this.completionGate;
    signal.throwIfAborted();
    yield {
      type: "completed",
      finishReason: "completed",
      usage: { inputTokens: 10, outputTokens: 2 },
    };
  }
}
