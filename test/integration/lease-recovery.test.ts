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
import type { FaultPoint } from "../../src/runtime/fault-injector.js";
import { CatalogService } from "../../src/config/catalog-service.js";
import { loadCatalog, type CatalogSnapshot } from "../../src/config/catalog-loader.js";
import {
  attemptIdFromUuid,
  runIdFromUuid,
  sessionIdFromUuid,
} from "../../src/domain/ids.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { FakeIds } from "../helpers/fake-ids.js";
import { FakeTool } from "../helpers/fake-tool.js";
import { completedText, ScriptedModel } from "../helpers/scripted-model.js";
import { tempPath } from "../helpers/temp-dir.js";

describe("lease recovery", () => {
  let snapshot: CatalogSnapshot;
  beforeAll(async () => { snapshot = await loadCatalog(path.resolve("test/fixtures/config/valid/myagent.yaml")); });

  it("marks an abandoned side effect unknown and retries an abandoned read-only Tool", async () => {
    const connection = openDatabase({ path: tempPath("lease-recovery.db"), busyTimeoutMs: 5_000 });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const tools = new SqliteToolRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const ids = new FakeIds({ sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000051"), sessionIdFromUuid("00000000-0000-7000-8000-000000000052")], runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000051"), runIdFromUuid("00000000-0000-7000-8000-000000000052")] });
      const create = new CreateRunService(new CatalogService(snapshot), runs, clock, ids);
      const side = create.execute({ agentId: "primary", sessionKey: "recover:side", input: { type: "text", text: "x" }, idempotencyKey: "recover-side-0001", source: { kind: "http" } });
      const read = create.execute({ agentId: "primary", sessionKey: "recover:read", input: { type: "text", text: "x" }, idempotencyKey: "recover-read-0001", source: { kind: "http" } });
      clock.advanceBy(1_000);
      for (const [run, call, effect, name] of [[side, "call-side", "side_effect", "run_command"], [read, "call-read", "read_only", "read_file"]] as const) {
        runs.claimNextEligible("old", clock.now(), new Date(clock.now().getTime() + 1));
        connection.db.prepare(`INSERT INTO tool_calls (tool_call_id, run_id, state, tool_name, effect, arguments_json, canonical_arguments, arguments_sha256, policy_effect, policy_facts_json, created_at, updated_at) VALUES (?, ?, 'executing', ?, ?, '{}', '{}', 'digest', 'allow', '{}', ?, ?)`).run(call, run.runId, name, effect, clock.now().toISOString(), clock.now().toISOString());
      }
      clock.advanceBy(2_000);
      const registry = new ToolRegistry();
      const fake = new FakeTool({ name: "read_file", effect: "read_only", normalizedArguments: {} }); registry.register(fake);
      const service = new AdvanceRunService({ runs, tools, approvals: new SqliteApprovalRepository(connection.db), sessions, model: new ScriptedModel(), prompts: new PromptAssembler(sessions), registry, policy: new PolicyEngine(), clock, ids });
      runs.claimNextEligible("recovery", clock.now(), new Date(clock.now().getTime() + 30_000));
      runs.claimNextEligible("recovery", clock.now(), new Date(clock.now().getTime() + 30_000));

      expect(await service.advance(side.runId, "recovery", new AbortController().signal)).toMatchObject({ type: "waiting", state: "waiting_reconciliation" });
      expect(tools.getLatestForRun(side.runId)?.state).toBe("unknown");
      expect(runs.getRun(side.runId).budget.activeExecutionSeconds).toBe(2);
      await service.advance(read.runId, "recovery", new AbortController().signal);
      await service.advance(read.runId, "recovery", new AbortController().signal);
      expect(fake.executions).toBe(1);
    } finally { connection.close(); }
  });

  it("fails an unmatched model attempt before starting a new one", async () => {
    const connection = openDatabase({
      path: tempPath("model-attempt-recovery.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const recoveredAttemptId = attemptIdFromUuid(
        "00000000-0000-7000-8000-000000000061",
      );
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000061")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000061")],
        attemptIds: [
          attemptIdFromUuid("00000000-0000-7000-8000-000000000062"),
        ],
      });
      const created = new CreateRunService(
        new CatalogService(snapshot),
        runs,
        clock,
        ids,
      ).execute({
        agentId: "primary",
        sessionKey: "recover:model-attempt",
        input: { type: "text", text: "resume safely" },
        idempotencyKey: "recover-model-0001",
        source: { kind: "http" },
      });
      clock.advanceBy(1_000);
      runs.claimNextEligible(
        "old-worker",
        clock.now(),
        new Date(clock.now().getTime() + 1),
      );
      runs.beginModelAttempt({
        runId: created.runId,
        leaseOwner: "old-worker",
        attemptId: recoveredAttemptId,
        purpose: "run",
        consumeModelTurn: true,
        modelTurnLimit: 20,
        occurredAt: clock.now(),
      });
      clock.advanceBy(2_000);
      runs.claimNextEligible(
        "recovery-worker",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const model = new ScriptedModel();
      model.script(completedText("recovered answer"));
      const faultSnapshots: Array<{
        point: FaultPoint;
        failedAttempts: number;
      }> = [];
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
            faultSnapshots.push({
              point,
              failedAttempts: runs.listEventsAfter(created.runId, 0).filter(
                (event) => event.type === "model.attempt.failed",
              ).length,
            });
          },
        },
      });

      expect(await service.advance(
        created.runId,
        "recovery-worker",
        new AbortController().signal,
      )).toEqual({ type: "advanced", runId: created.runId });
      expect(model.requests).toHaveLength(0);
      expect(faultSnapshots).toEqual([
        { point: "before_model_attempt_commit", failedAttempts: 0 },
        { point: "after_model_attempt_commit", failedAttempts: 1 },
      ]);
      expect(
        runs.listEventsAfter(created.runId, 0).filter(
          (event) => event.type === "model.attempt.failed",
        ),
      ).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            attemptId: recoveredAttemptId,
            code: "model_attempt_abandoned",
          }),
        }),
      ]);

      expect(await service.advance(
        created.runId,
        "recovery-worker",
        new AbortController().signal,
      )).toEqual({
        type: "terminal",
        runId: created.runId,
        state: "completed",
      });
    } finally {
      connection.close();
    }
  });

  it("rejects a Summary commit after the provider lease is lost", () => {
    const connection = openDatabase({
      path: tempPath("summary-lease-recovery.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const sessions = new SqliteSessionRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000071")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000071")],
      });
      const created = new CreateRunService(
        new CatalogService(snapshot),
        runs,
        clock,
        ids,
      ).execute({
        agentId: "primary",
        sessionKey: "recover:summary-lease",
        input: { type: "text", text: "summarize safely" },
        idempotencyKey: "recover-summary-0001",
        source: { kind: "http" },
      });
      clock.advanceBy(1_000);
      runs.claimNextEligible(
        "provider-worker",
        clock.now(),
        new Date(clock.now().getTime() + 1),
      );
      clock.advanceBy(2_000);
      runs.claimNextEligible(
        "replacement-worker",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );

      expect(() => sessions.saveSummaryWithLease({
        runId: created.runId,
        leaseOwner: "provider-worker",
        occurredAt: clock.now(),
        summary: {
          summaryId: "summary:lost-lease",
          sessionId: created.sessionId,
          sourceMessageFrom: 0,
          sourceMessageTo: 0,
          content: "must not commit",
          modelProvider: "openai-compatible",
          modelName: "test-model",
          createdAt: clock.now(),
        },
      })).toThrowError(expect.objectContaining({ code: "run_lease_lost" }));
      expect(sessions.getCurrentSummary(created.sessionId)).toBeNull();
    } finally {
      connection.close();
    }
  });
});
