import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { SqliteCatalogRepository } from "../../src/adapters/sqlite/catalog-repository.js";
import { openDatabase } from "../../src/adapters/sqlite/database.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { SqliteRunRepository } from "../../src/adapters/sqlite/run-repository.js";
import { SqliteSessionRepository } from "../../src/adapters/sqlite/session-repository.js";
import { SqliteToolRepository } from "../../src/adapters/sqlite/tool-repository.js";
import { DelegateAgentService } from "../../src/application/delegate-agent.js";
import { CreateRunService } from "../../src/application/create-run.js";
import { CatalogService } from "../../src/config/catalog-service.js";
import { loadCatalog, type CatalogSnapshot } from "../../src/config/catalog-loader.js";
import { attemptIdFromUuid, parseAgentId, runIdFromUuid, sessionIdFromUuid, toolCallIdFromUuid } from "../../src/domain/ids.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { FakeIds } from "../helpers/fake-ids.js";
import { tempPath } from "../helpers/temp-dir.js";

describe("delegation", () => {
  let snapshot: CatalogSnapshot;
  beforeAll(async () => {
    snapshot = await loadCatalog(path.resolve("test/fixtures/config/valid/myagent.yaml"));
  });

  it("creates one child, blocks its parent, and queues the parent after child completion", () => {
    const connection = openDatabase({ path: tempPath("delegation-resume.db"), busyTimeoutMs: 5_000 });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const tools = new SqliteToolRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000201"), sessionIdFromUuid("00000000-0000-7000-8000-000000000202")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000201"), runIdFromUuid("00000000-0000-7000-8000-000000000202")],
        toolCallIds: [toolCallIdFromUuid("00000000-0000-7000-8000-000000000201")],
        attemptIds: [attemptIdFromUuid("00000000-0000-7000-8000-000000000201")],
      });
      const parent = new CreateRunService(new CatalogService(snapshot), runs, clock, ids).execute({
        agentId: "primary", sessionKey: "delegation:parent", input: { type: "text", text: "parent secret must not be copied" }, idempotencyKey: "delegation-parent-0001", source: { kind: "http" },
      });
      clock.advanceBy(1_000);
      runs.claimNextEligible("parent-worker", clock.now(), new Date(clock.now().getTime() + 30_000));
      const call = tools.recordProposal({
        runId: parent.runId, leaseOwner: "parent-worker", toolCallId: ids.toolCallId(), toolName: "delegate_agent", effect: "side_effect", arguments: { targetAgentId: "researcher", task: "research", context: { topic: "tests" } }, canonicalArguments: "{\"context\":{\"topic\":\"tests\"},\"targetAgentId\":\"researcher\",\"task\":\"research\"}", argumentsSha256: "a".repeat(64), policyFacts: { targetAgentInDelegates: true }, policyEffect: "allow", matchedRule: 0, toolCallLimit: 12, occurredAt: clock.now(),
      });
      tools.beginExecution({ runId: parent.runId, toolCallId: call.toolCallId, leaseOwner: "parent-worker", occurredAt: clock.now() });
      const delegate = new DelegateAgentService({ catalog: new CatalogService(snapshot), runs, clock, ids });
      const child = delegate.execute({ parentRunId: parent.runId, parentToolCallId: call.toolCallId, targetAgentId: parseAgentId("researcher"), task: "research", context: { topic: "tests" }, leaseOwner: "parent-worker" });

      expect(runs.getRun(parent.runId).state).toBe("running");
      expect(runs.claimNextEligible("child-worker", clock.now(), new Date(clock.now().getTime() + 30_000))?.runId).toBe(child.childRunId);
      expect(connection.db.prepare("SELECT owner_session_id FROM sessions WHERE session_id = ?").get(child.childSessionId)).toEqual({ owner_session_id: parent.sessionId });
      expect(connection.db.prepare("SELECT content_json FROM messages WHERE session_id = ?").get(child.childSessionId)).toEqual({ content_json: "{\"text\":\"{\\\"task\\\":\\\"research\\\",\\\"context\\\":{\\\"topic\\\":\\\"tests\\\"}}\",\"type\":\"text\"}" });

      runs.beginModelAttempt({ runId: child.childRunId, leaseOwner: "child-worker", attemptId: ids.attemptId(), purpose: "run", consumeModelTurn: true, modelTurnLimit: 20, occurredAt: clock.now() });
      runs.completeRun({ runId: child.childRunId, leaseOwner: "child-worker", attemptId: attemptIdFromUuid("00000000-0000-7000-8000-000000000201"), text: "child answer", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, occurredAt: clock.now() });

      expect(runs.getRun(parent.runId).state).toBe("queued");
      expect(tools.getLatestForRun(parent.runId)).toMatchObject({ state: "succeeded" });
      expect(runs.listEventsAfter(parent.runId, 0).map((event) => event.type)).toContain("delegation.completed");
    } finally { connection.close(); }
  });

  it("cancels a blocked parent and its queued child", () => {
    const connection = openDatabase({ path: tempPath("delegation-cancel.db"), busyTimeoutMs: 5_000 });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const tools = new SqliteToolRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000211"), sessionIdFromUuid("00000000-0000-7000-8000-000000000212")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000211"), runIdFromUuid("00000000-0000-7000-8000-000000000212")],
        toolCallIds: [toolCallIdFromUuid("00000000-0000-7000-8000-000000000211")],
      });
      const parent = new CreateRunService(new CatalogService(snapshot), runs, clock, ids).execute({ agentId: "primary", sessionKey: "delegation:cancel", input: { type: "text", text: "cancel" }, idempotencyKey: "delegation-cancel-0001", source: { kind: "http" } });
      clock.advanceBy(1_000);
      runs.claimNextEligible("parent-worker", clock.now(), new Date(clock.now().getTime() + 30_000));
      const call = tools.recordProposal({ runId: parent.runId, leaseOwner: "parent-worker", toolCallId: ids.toolCallId(), toolName: "delegate_agent", effect: "side_effect", arguments: {}, canonicalArguments: "{}", argumentsSha256: "b".repeat(64), policyFacts: { targetAgentInDelegates: true }, policyEffect: "allow", matchedRule: 0, toolCallLimit: 12, occurredAt: clock.now() });
      tools.beginExecution({ runId: parent.runId, toolCallId: call.toolCallId, leaseOwner: "parent-worker", occurredAt: clock.now() });
      const child = new DelegateAgentService({ catalog: new CatalogService(snapshot), runs, clock, ids }).execute({ parentRunId: parent.runId, parentToolCallId: call.toolCallId, targetAgentId: parseAgentId("researcher"), task: "cancel", context: {}, leaseOwner: "parent-worker" });

      runs.cancel({ runId: parent.runId, occurredAt: clock.now() });

      expect(runs.getRun(parent.runId).state).toBe("cancelled");
      expect(runs.getRun(child.childRunId).state).toBe("cancelled");
    } finally { connection.close(); }
  });

  it("deletes a root Session and cascades its records", () => {
    const connection = openDatabase({ path: tempPath("delegation-delete.db"), busyTimeoutMs: 5_000 });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const created = new CreateRunService(new CatalogService(snapshot), runs, clock, new FakeIds({ sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000221")], runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000221")] })).execute({ agentId: "primary", sessionKey: "delegation:delete", input: { type: "text", text: "delete" }, idempotencyKey: "delegation-delete-0001", source: { kind: "http" } });
      const sessions = new SqliteSessionRepository(connection.db);

      sessions.delete(created.sessionId);

      expect(connection.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE session_id = ?").get(created.sessionId)).toEqual({ count: 0 });
      expect(() => sessions.delete(created.sessionId)).toThrow(expect.objectContaining({ code: "session_not_found" }));
    } finally { connection.close(); }
  });

  it("retries an unlinked delegation checkpoint without marking it unknown", () => {
    const connection = openDatabase({ path: tempPath("delegation-recovery.db"), busyTimeoutMs: 5_000 });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const tools = new SqliteToolRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const ids = new FakeIds({ sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000231")], runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000231")], toolCallIds: [toolCallIdFromUuid("00000000-0000-7000-8000-000000000231")] });
      const run = new CreateRunService(new CatalogService(snapshot), runs, clock, ids).execute({ agentId: "primary", sessionKey: "delegation:recover", input: { type: "text", text: "recover" }, idempotencyKey: "delegation-recover-0001", source: { kind: "http" } });
      runs.claimNextEligible("worker-a", clock.now(), new Date(clock.now().getTime() + 1));
      const call = tools.recordProposal({ runId: run.runId, leaseOwner: "worker-a", toolCallId: ids.toolCallId(), toolName: "delegate_agent", effect: "side_effect", arguments: {}, canonicalArguments: "{}", argumentsSha256: "c".repeat(64), policyFacts: { targetAgentInDelegates: true }, policyEffect: "allow", matchedRule: 0, toolCallLimit: 12, occurredAt: clock.now() });
      tools.beginExecution({ runId: run.runId, toolCallId: call.toolCallId, leaseOwner: "worker-a", occurredAt: clock.now() });
      clock.advanceBy(2);
      runs.claimNextEligible("worker-b", clock.now(), new Date(clock.now().getTime() + 30_000));

      expect(tools.recoverExecuting({ runId: run.runId, toolCallId: call.toolCallId, leaseOwner: "worker-b", occurredAt: clock.now() })).toBe("retry");
      expect(tools.getLatestForRun(run.runId)?.state).toBe("allowed");
    } finally { connection.close(); }
  });
});
