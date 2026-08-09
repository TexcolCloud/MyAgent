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
import { approvalIdFromUuid, attemptIdFromUuid, parseAgentId, runIdFromUuid, sessionIdFromUuid, toolCallIdFromUuid } from "../../src/domain/ids.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { FakeIds } from "../helpers/fake-ids.js";
import { resolvedAgents } from "../helpers/resolved-agents.js";
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
      const parent = new CreateRunService(resolvedAgents(new CatalogService(snapshot)), runs, clock, ids).execute({
        agentId: "primary", sessionKey: "delegation:parent", input: { type: "text", text: "parent secret must not be copied" }, idempotencyKey: "delegation-parent-0001", source: { kind: "http" },
      });
      clock.advanceBy(1_000);
      runs.claimNextEligible("parent-worker", clock.now(), new Date(clock.now().getTime() + 30_000));
      const call = tools.recordProposal({
        runId: parent.runId, leaseOwner: "parent-worker", toolCallId: ids.toolCallId(), providerCallId: "provider_delegate_parent", toolName: "delegate_agent", effect: "side_effect", arguments: { targetAgentId: "researcher", task: "research", context: { topic: "tests" } }, canonicalArguments: "{\"context\":{\"topic\":\"tests\"},\"targetAgentId\":\"researcher\",\"task\":\"research\"}", argumentsSha256: "a".repeat(64), policyFacts: { targetAgentInDelegates: true }, policyEffect: "allow", matchedRule: 0, toolCallLimit: 12, occurredAt: clock.now(),
      });
      tools.beginExecution({ runId: parent.runId, toolCallId: call.toolCallId, leaseOwner: "parent-worker", occurredAt: clock.now() });
      const delegate = new DelegateAgentService({ agents: resolvedAgents(new CatalogService(snapshot)), runs, clock, ids });
      const child = delegate.execute({ parentRunId: parent.runId, parentToolCallId: call.toolCallId, targetAgentId: parseAgentId("researcher"), task: "research", context: { topic: "tests" }, leaseOwner: "parent-worker" });

      expect(runs.getRun(parent.runId).state).toBe("running");
      expect(runs.claimNextEligible("child-worker", clock.now(), new Date(clock.now().getTime() + 30_000))?.runId).toBe(child.childRunId);
      expect(connection.db.prepare("SELECT owner_session_id FROM sessions WHERE session_id = ?").get(child.childSessionId)).toEqual({ owner_session_id: parent.sessionId });
      expect(connection.db.prepare("SELECT content_json FROM messages WHERE session_id = ?").get(child.childSessionId)).toEqual({ content_json: "{\"text\":\"{\\\"task\\\":\\\"research\\\",\\\"context\\\":{\\\"topic\\\":\\\"tests\\\"}}\",\"type\":\"text\"}" });

      runs.beginModelAttempt({ runId: child.childRunId, leaseOwner: "child-worker", attemptId: ids.attemptId(), purpose: "run", consumeModelTurn: true, modelTurnLimit: 20, occurredAt: clock.now() });
      runs.completeRun({ runId: child.childRunId, leaseOwner: "child-worker", attemptId: attemptIdFromUuid("00000000-0000-7000-8000-000000000201"), text: "child answer", finishReason: "completed", usage: { inputTokens: 1, outputTokens: 1 }, occurredAt: clock.now() });

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
      const parent = new CreateRunService(resolvedAgents(new CatalogService(snapshot)), runs, clock, ids).execute({ agentId: "primary", sessionKey: "delegation:cancel", input: { type: "text", text: "cancel" }, idempotencyKey: "delegation-cancel-0001", source: { kind: "http" } });
      clock.advanceBy(1_000);
      runs.claimNextEligible("parent-worker", clock.now(), new Date(clock.now().getTime() + 30_000));
      const call = tools.recordProposal({ runId: parent.runId, leaseOwner: "parent-worker", toolCallId: ids.toolCallId(), providerCallId: "provider_delegate_cancel", toolName: "delegate_agent", effect: "side_effect", arguments: {}, canonicalArguments: "{}", argumentsSha256: "b".repeat(64), policyFacts: { targetAgentInDelegates: true }, policyEffect: "allow", matchedRule: 0, toolCallLimit: 12, occurredAt: clock.now() });
      tools.beginExecution({ runId: parent.runId, toolCallId: call.toolCallId, leaseOwner: "parent-worker", occurredAt: clock.now() });
      const child = new DelegateAgentService({ agents: resolvedAgents(new CatalogService(snapshot)), runs, clock, ids }).execute({ parentRunId: parent.runId, parentToolCallId: call.toolCallId, targetAgentId: parseAgentId("researcher"), task: "cancel", context: {}, leaseOwner: "parent-worker" });

      runs.cancel({ runId: parent.runId, occurredAt: clock.now() });

      expect(runs.getRun(parent.runId).state).toBe("cancelled");
      expect(runs.getRun(child.childRunId).state).toBe("cancelled");
    } finally { connection.close(); }
  });

  it("resumes a blocked parent when its child is cancelled directly", () => {
    const connection = openDatabase({ path: tempPath("delegation-child-cancel.db"), busyTimeoutMs: 5_000 });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const tools = new SqliteToolRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000241"), sessionIdFromUuid("00000000-0000-7000-8000-000000000242")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000241"), runIdFromUuid("00000000-0000-7000-8000-000000000242")],
        toolCallIds: [toolCallIdFromUuid("00000000-0000-7000-8000-000000000241")],
      });
      const parent = new CreateRunService(resolvedAgents(new CatalogService(snapshot)), runs, clock, ids).execute({ agentId: "primary", sessionKey: "delegation:child-cancel", input: { type: "text", text: "cancel child" }, idempotencyKey: "delegation-child-cancel-0001", source: { kind: "http" } });
      runs.claimNextEligible("parent-worker", clock.now(), new Date(clock.now().getTime() + 30_000));
      const call = tools.recordProposal({ runId: parent.runId, leaseOwner: "parent-worker", toolCallId: ids.toolCallId(), providerCallId: "provider_delegate_child_cancel", toolName: "delegate_agent", effect: "side_effect", arguments: {}, canonicalArguments: "{}", argumentsSha256: "d".repeat(64), policyFacts: { targetAgentInDelegates: true }, policyEffect: "allow", matchedRule: 0, toolCallLimit: 12, occurredAt: clock.now() });
      tools.beginExecution({ runId: parent.runId, toolCallId: call.toolCallId, leaseOwner: "parent-worker", occurredAt: clock.now() });
      const child = new DelegateAgentService({ agents: resolvedAgents(new CatalogService(snapshot)), runs, clock, ids }).execute({ parentRunId: parent.runId, parentToolCallId: call.toolCallId, targetAgentId: parseAgentId("researcher"), task: "cancel me", context: {}, leaseOwner: "parent-worker" });

      runs.cancel({ runId: child.childRunId, occurredAt: clock.now() });

      expect(runs.getRun(child.childRunId).state).toBe("cancelled");
      expect(runs.getRun(parent.runId).state).toBe("queued");
      expect(tools.getLatestForRun(parent.runId)).toMatchObject({ state: "failed" });
      expect(runs.listEventsAfter(parent.runId, 0).map((event) => event.type)).toContain("delegation.completed");
    } finally { connection.close(); }
  });

  it("returns one child for repeated delegation and enforces the root child cap", () => {
    const connection = openDatabase({ path: tempPath("delegation-idempotency.db"), busyTimeoutMs: 5_000 });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const tools = new SqliteToolRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000251"), sessionIdFromUuid("00000000-0000-7000-8000-000000000252"), sessionIdFromUuid("00000000-0000-7000-8000-000000000253")],
        runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000251"), runIdFromUuid("00000000-0000-7000-8000-000000000252"), runIdFromUuid("00000000-0000-7000-8000-000000000253")],
        toolCallIds: [toolCallIdFromUuid("00000000-0000-7000-8000-000000000251")],
      });
      const parent = new CreateRunService(resolvedAgents(new CatalogService(snapshot)), runs, clock, ids).execute({ agentId: "primary", sessionKey: "delegation:idempotency", input: { type: "text", text: "delegate" }, idempotencyKey: "delegation-idempotency-0001", source: { kind: "http" } });
      runs.claimNextEligible("parent-worker", clock.now(), new Date(clock.now().getTime() + 30_000));
      const call = tools.recordProposal({ runId: parent.runId, leaseOwner: "parent-worker", toolCallId: ids.toolCallId(), providerCallId: "provider_delegate_idempotency", toolName: "delegate_agent", effect: "side_effect", arguments: {}, canonicalArguments: "{}", argumentsSha256: "e".repeat(64), policyFacts: { targetAgentInDelegates: true }, policyEffect: "allow", matchedRule: 0, toolCallLimit: 12, occurredAt: clock.now() });
      tools.beginExecution({ runId: parent.runId, toolCallId: call.toolCallId, leaseOwner: "parent-worker", occurredAt: clock.now() });
      const service = new DelegateAgentService({ agents: resolvedAgents(new CatalogService(snapshot)), runs, clock, ids });
      const command = { parentRunId: parent.runId, parentToolCallId: call.toolCallId, targetAgentId: parseAgentId("researcher"), task: "once", context: {}, leaseOwner: "parent-worker" } as const;

      const first = service.execute(command);
      expect(service.execute(command)).toEqual(first);
      expect(connection.db.prepare("SELECT child_run_count FROM runs WHERE run_id = ?").get(parent.runId)).toEqual({ child_run_count: 1 });
    } finally { connection.close(); }

    const capped = openDatabase({ path: tempPath("delegation-cap.db"), busyTimeoutMs: 5_000 });
    try {
      migrate(capped.db);
      const catalog = new SqliteCatalogRepository(capped.db);
      const runs = new SqliteRunRepository(capped.db, catalog);
      const tools = new SqliteToolRepository(capped.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const ids = new FakeIds({ sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000261"), sessionIdFromUuid("00000000-0000-7000-8000-000000000262")], runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000261"), runIdFromUuid("00000000-0000-7000-8000-000000000262")], toolCallIds: [toolCallIdFromUuid("00000000-0000-7000-8000-000000000261")] });
      const parent = new CreateRunService(resolvedAgents(new CatalogService(snapshot)), runs, clock, ids).execute({ agentId: "primary", sessionKey: "delegation:cap", input: { type: "text", text: "cap" }, idempotencyKey: "delegation-cap-0001", source: { kind: "http" } });
      runs.claimNextEligible("parent-worker", clock.now(), new Date(clock.now().getTime() + 30_000));
      const call = tools.recordProposal({ runId: parent.runId, leaseOwner: "parent-worker", toolCallId: ids.toolCallId(), providerCallId: "provider_delegate_cap", toolName: "delegate_agent", effect: "side_effect", arguments: {}, canonicalArguments: "{}", argumentsSha256: "f".repeat(64), policyFacts: { targetAgentInDelegates: true }, policyEffect: "allow", matchedRule: 0, toolCallLimit: 12, occurredAt: clock.now() });
      tools.beginExecution({ runId: parent.runId, toolCallId: call.toolCallId, leaseOwner: "parent-worker", occurredAt: clock.now() });
      capped.db.prepare("UPDATE runs SET child_run_count = 4 WHERE run_id = ?").run(parent.runId);

      expect(() => new DelegateAgentService({ agents: resolvedAgents(new CatalogService(snapshot)), runs, clock, ids }).execute({ parentRunId: parent.runId, parentToolCallId: call.toolCallId, targetAgentId: parseAgentId("researcher"), task: "too many", context: {}, leaseOwner: "parent-worker" })).toThrow(expect.objectContaining({ code: "delegation_count_exceeded" }));
    } finally { capped.close(); }
  });

  it("resumes a blocked parent after active child cancellation finalizes", () => {
    const connection = openDatabase({ path: tempPath("delegation-child-finalize.db"), busyTimeoutMs: 5_000 });
    try {
      const setup = createBlockedDelegation(connection, snapshot, 271, "delegation:child-finalize");
      expect(setup.runs.claimNextEligible("child-worker", setup.clock.now(), new Date(setup.clock.now().getTime() + 30_000))?.runId).toBe(setup.child.childRunId);

      setup.runs.cancel({ runId: setup.child.childRunId, occurredAt: setup.clock.now() });
      setup.runs.finalizeCancellation({ runId: setup.child.childRunId, leaseOwner: "child-worker", occurredAt: setup.clock.now() });

      expect(setup.runs.getRun(setup.parent.runId).state).toBe("queued");
      expect(setup.tools.getLatestForRun(setup.parent.runId)).toMatchObject({ state: "failed" });
    } finally { connection.close(); }
  });

  it("denies a child Approval when its blocked parent is cancelled", () => {
    const connection = openDatabase({ path: tempPath("delegation-child-approval.db"), busyTimeoutMs: 5_000 });
    try {
      const setup = createBlockedDelegation(connection, snapshot, 281, "delegation:child-approval");
      setup.runs.claimNextEligible("child-worker", setup.clock.now(), new Date(setup.clock.now().getTime() + 30_000));
      const childToolCallId = toolCallIdFromUuid("00000000-0000-7000-8000-000000000289");
      const approvalId = approvalIdFromUuid("00000000-0000-7000-8000-000000000289");
      setup.tools.recordProposal({ runId: setup.child.childRunId, leaseOwner: "child-worker", toolCallId: childToolCallId, providerCallId: "provider_child_approval", toolName: "write_file", effect: "side_effect", arguments: {}, canonicalArguments: "{}", argumentsSha256: "9".repeat(64), policyFacts: {}, policyEffect: "ask", matchedRule: 0, toolCallLimit: 12, approvalId, approvalExpiresAt: new Date(setup.clock.now().getTime() + 86_400_000), occurredAt: setup.clock.now() });

      setup.runs.cancel({ runId: setup.parent.runId, occurredAt: setup.clock.now() });

      expect(connection.db.prepare("SELECT state, resolution_reason FROM approvals WHERE approval_id = ?").get(approvalId)).toEqual({ state: "denied", resolution_reason: "run_cancelled" });
      expect(setup.runs.getRun(setup.child.childRunId).state).toBe("cancelled");
    } finally { connection.close(); }
  });

  it("deletes a root Session and cascades its records", () => {
    const connection = openDatabase({ path: tempPath("delegation-delete.db"), busyTimeoutMs: 5_000 });
    try {
      const setup = createBlockedDelegation(connection, snapshot, 221, "delegation:delete");
      const sessions = new SqliteSessionRepository(connection.db);

      expect(() => sessions.delete(setup.child.childSessionId)).toThrow(expect.objectContaining({ code: "synthetic_session_owned" }));
      sessions.delete(setup.parent.sessionId);

      expect(connection.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE session_id IN (?, ?)").get(setup.parent.sessionId, setup.child.childSessionId)).toEqual({ count: 0 });
      expect(() => sessions.delete(setup.parent.sessionId)).toThrow(expect.objectContaining({ code: "session_not_found" }));
    } finally { connection.close(); }
  });

  it("bounds a multi-byte child result by UTF-8 bytes", () => {
    const connection = openDatabase({ path: tempPath("delegation-result-limit.db"), busyTimeoutMs: 5_000 });
    try {
      const setup = createBlockedDelegation(connection, snapshot, 291, "delegation:result-limit");
      setup.runs.claimNextEligible("child-worker", setup.clock.now(), new Date(setup.clock.now().getTime() + 30_000));
      const attemptId = attemptIdFromUuid("00000000-0000-7000-8000-000000000299");
      setup.runs.beginModelAttempt({ runId: setup.child.childRunId, leaseOwner: "child-worker", attemptId, purpose: "run", consumeModelTurn: true, modelTurnLimit: 20, occurredAt: setup.clock.now() });
      setup.runs.completeRun({ runId: setup.child.childRunId, leaseOwner: "child-worker", attemptId, text: "汉".repeat(11_000), finishReason: "completed", usage: { inputTokens: 1, outputTokens: 1 }, occurredAt: setup.clock.now() });

      const row = connection.db.prepare("SELECT result_json FROM tool_calls WHERE run_id = ? AND tool_name = 'delegate_agent'").get(setup.parent.runId) as { result_json: string };
      const result = JSON.parse(row.result_json) as { content: { result: unknown } };
      expect(Buffer.byteLength(JSON.stringify(result.content.result), "utf8")).toBeLessThanOrEqual(32_768);
    } finally { connection.close(); }
  });

  it("includes the result envelope in the child result byte bound", () => {
    const connection = openDatabase({ path: tempPath("delegation-result-envelope.db"), busyTimeoutMs: 5_000 });
    try {
      const setup = createBlockedDelegation(connection, snapshot, 301, "delegation:result-envelope");
      setup.runs.claimNextEligible("child-worker", setup.clock.now(), new Date(setup.clock.now().getTime() + 30_000));
      const attemptId = attemptIdFromUuid("00000000-0000-7000-8000-000000000309");
      setup.runs.beginModelAttempt({ runId: setup.child.childRunId, leaseOwner: "child-worker", attemptId, purpose: "run", consumeModelTurn: true, modelTurnLimit: 20, occurredAt: setup.clock.now() });
      setup.runs.completeRun({ runId: setup.child.childRunId, leaseOwner: "child-worker", attemptId, text: "x".repeat(32_720), finishReason: "completed", usage: { inputTokens: 1, outputTokens: 1 }, occurredAt: setup.clock.now() });

      const row = connection.db.prepare("SELECT result_json FROM tool_calls WHERE run_id = ? AND tool_name = 'delegate_agent'").get(setup.parent.runId) as { result_json: string };
      const result = JSON.parse(row.result_json) as { content: { result: unknown } };
      expect(Buffer.byteLength(JSON.stringify(result.content.result), "utf8")).toBeLessThanOrEqual(32_768);
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
      const run = new CreateRunService(resolvedAgents(new CatalogService(snapshot)), runs, clock, ids).execute({ agentId: "primary", sessionKey: "delegation:recover", input: { type: "text", text: "recover" }, idempotencyKey: "delegation-recover-0001", source: { kind: "http" } });
      runs.claimNextEligible("worker-a", clock.now(), new Date(clock.now().getTime() + 1));
      const call = tools.recordProposal({ runId: run.runId, leaseOwner: "worker-a", toolCallId: ids.toolCallId(), providerCallId: "provider_delegate_recovery", toolName: "delegate_agent", effect: "side_effect", arguments: {}, canonicalArguments: "{}", argumentsSha256: "c".repeat(64), policyFacts: { targetAgentInDelegates: true }, policyEffect: "allow", matchedRule: 0, toolCallLimit: 12, occurredAt: clock.now() });
      tools.beginExecution({ runId: run.runId, toolCallId: call.toolCallId, leaseOwner: "worker-a", occurredAt: clock.now() });
      clock.advanceBy(2);
      runs.claimNextEligible("worker-b", clock.now(), new Date(clock.now().getTime() + 30_000));

      expect(tools.recoverExecuting({ runId: run.runId, toolCallId: call.toolCallId, leaseOwner: "worker-b", occurredAt: clock.now() })).toBe("retry");
      expect(tools.getLatestForRun(run.runId)?.state).toBe("allowed");
    } finally { connection.close(); }
  });
});

function createBlockedDelegation(
  connection: ReturnType<typeof openDatabase>,
  snapshot: CatalogSnapshot,
  idBase: number,
  sessionKey: string,
) {
  migrate(connection.db);
  const catalog = new SqliteCatalogRepository(connection.db);
  const runs = new SqliteRunRepository(connection.db, catalog);
  const tools = new SqliteToolRepository(connection.db);
  const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
  const parentUuid = numberedUuid(idBase);
  const childUuid = numberedUuid(idBase + 1);
  const ids = new FakeIds({
    sessionIds: [sessionIdFromUuid(parentUuid), sessionIdFromUuid(childUuid)],
    runIds: [runIdFromUuid(parentUuid), runIdFromUuid(childUuid)],
    toolCallIds: [toolCallIdFromUuid(parentUuid)],
  });
  const parent = new CreateRunService(resolvedAgents(new CatalogService(snapshot)), runs, clock, ids).execute({ agentId: "primary", sessionKey, input: { type: "text", text: "delegate" }, idempotencyKey: `delegation-${String(idBase).padStart(8, "0")}`, source: { kind: "http" } });
  runs.claimNextEligible("parent-worker", clock.now(), new Date(clock.now().getTime() + 30_000));
  const call = tools.recordProposal({ runId: parent.runId, leaseOwner: "parent-worker", toolCallId: ids.toolCallId(), providerCallId: "provider_delegate_blocked", toolName: "delegate_agent", effect: "side_effect", arguments: {}, canonicalArguments: "{}", argumentsSha256: "8".repeat(64), policyFacts: { targetAgentInDelegates: true }, policyEffect: "allow", matchedRule: 0, toolCallLimit: 12, occurredAt: clock.now() });
  tools.beginExecution({ runId: parent.runId, toolCallId: call.toolCallId, leaseOwner: "parent-worker", occurredAt: clock.now() });
  const child = new DelegateAgentService({ agents: resolvedAgents(new CatalogService(snapshot)), runs, clock, ids }).execute({ parentRunId: parent.runId, parentToolCallId: call.toolCallId, targetAgentId: parseAgentId("researcher"), task: "child", context: {}, leaseOwner: "parent-worker" });
  return { runs, tools, clock, parent, child };
}

function numberedUuid(value: number): string {
  return `00000000-0000-7000-8000-${String(value).padStart(12, "0")}`;
}
