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
import { runIdFromUuid, sessionIdFromUuid } from "../../src/domain/ids.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { FakeIds } from "../helpers/fake-ids.js";
import { FakeTool } from "../helpers/fake-tool.js";
import { ScriptedModel } from "../helpers/scripted-model.js";
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
      await service.advance(read.runId, "recovery", new AbortController().signal);
      await service.advance(read.runId, "recovery", new AbortController().signal);
      expect(fake.executions).toBe(1);
    } finally { connection.close(); }
  });
});
