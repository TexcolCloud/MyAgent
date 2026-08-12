import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { SqliteCatalogRepository } from "../../src/adapters/sqlite/catalog-repository.js";
import { SqliteApprovalRepository } from "../../src/adapters/sqlite/approval-repository.js";
import { openDatabase } from "../../src/adapters/sqlite/database.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { SqliteRunRepository } from "../../src/adapters/sqlite/run-repository.js";
import { SqliteSessionRepository } from "../../src/adapters/sqlite/session-repository.js";
import { SqliteToolRepository } from "../../src/adapters/sqlite/tool-repository.js";
import { ToolRegistry } from "../../src/adapters/tools/registry.js";
import { AdvanceRunService } from "../../src/application/advance-run.js";
import { CreateRunService } from "../../src/application/create-run.js";
import { DecideApprovalService } from "../../src/application/decide-approval.js";
import { PolicyEngine } from "../../src/application/policy-engine.js";
import { PromptAssembler } from "../../src/application/prompt-assembler.js";
import { ReconcileToolCallService } from "../../src/application/reconcile-tool-call.js";
import { CatalogService } from "../../src/config/catalog-service.js";
import { loadCatalog, type CatalogSnapshot } from "../../src/config/catalog-loader.js";
import {
  approvalIdFromUuid,
  runIdFromUuid,
  sessionIdFromUuid,
  toolCallIdFromUuid,
} from "../../src/domain/ids.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { FakeIds } from "../helpers/fake-ids.js";
import { noOpProviderHealthSink } from "../helpers/provider-health.js";
import { resolvedAgents } from "../helpers/resolved-agents.js";
import { ScriptedModel } from "../helpers/scripted-model.js";
import { tempPath } from "../helpers/temp-dir.js";
import { ApprovalExpirer } from "../../src/runtime/approval-expirer.js";
import { ApprovalScreen } from "../../src/interfaces/tui/screens/approvals.js";
import { TuiClient } from "../../src/interfaces/tui/tui-client.js";
import { startTestApp } from "../helpers/start-test-app.js";

describe("Approval and reconciliation resume", () => {
  let snapshot: CatalogSnapshot;

  beforeAll(async () => {
    snapshot = await loadCatalog(
      path.resolve("test/fixtures/config/valid/myagent.yaml"),
    );
  });

  it("keeps a TUI decision exact and server-authoritative through the Run API", async () => {
    const harness = await startTestApp();
    try {
      const created = await harness.app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: {
          authorization: "Bearer test-token",
          "idempotency-key": "tui-approval-resume-0001",
        },
        payload: {
          agentId: "primary",
          sessionKey: "tui:approval-resume",
          input: { type: "text", text: "check exact approval" },
        },
      });
      const runId = created.json().runId as string;
      seedTuiApproval(harness.connection.db, runId);
      const decisionAuthorizations: (string | null)[] = [];
      const client = new TuiClient({
        runToken: "test-token",
        adminToken: "test-admin-token",
        fetcher: async (input, init) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/decision")) {
            decisionAuthorizations.push(new Headers(init?.headers).get("authorization"));
          }
          const response = await harness.app.inject({
            method: (init?.method ?? "GET") as never,
            url: `${url.pathname}${url.search}`,
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            ...(typeof init?.body === "string" ? { payload: init.body } : {}),
          });
          return new Response(response.payload, {
            status: response.statusCode,
            headers: response.headers as Record<string, string>,
          });
        },
      });
      const approvals = new ApprovalScreen({ client });

      await approvals.load();
      await approvals.select("approval-tui-1");
      expect(approvals.render(120).join("\n")).toContain("This command runs on the host");
      await expect(approvals.decide("approved")).resolves.toBe(true);
      await expect(approvals.decide("denied")).resolves.toBe(false);

      const rendered = approvals.render(120).join("\n");
      expect(decisionAuthorizations).toEqual(["Bearer test-token", "Bearer test-token"]);
      expect(rendered).toContain("approval_already_resolved");
      expect(rendered).toContain("Server state: approved");
      expect(rendered).not.toContain("Server state: denied");
    } finally {
      await harness.close();
    }
  });

  it.each(["succeeded", "failed"] as const)(
    "atomically records an Operator-supplied %s result and queues the Run",
    (outcome) => {
    const connection = openDatabase({
      path: tempPath(`reconcile-${outcome}.db`),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const tools = new SqliteToolRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const runId = runIdFromUuid("00000000-0000-7000-8000-000000000401");
      const toolCallId = toolCallIdFromUuid(
        "00000000-0000-7000-8000-000000000401",
      );
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000401")],
        runIds: [runId],
      });
      new CreateRunService(resolvedAgents(new CatalogService(snapshot)), runs, clock, ids).execute({
        agentId: "primary",
        sessionKey: `reconcile:${outcome}`,
        input: { type: "text", text: "check the side effect" },
        idempotencyKey: `reconcile-${outcome}-0001`,
        source: { kind: "http" },
      });
      runs.claimNextEligible(
        "seed-worker",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const occurredAt = clock.now().toISOString();
      connection.db.prepare(
        `INSERT INTO tool_calls (
           tool_call_id, run_id, state, tool_name, effect, arguments_json,
           canonical_arguments, arguments_sha256, policy_effect, matched_rule,
           policy_facts_json, created_at, updated_at
         ) VALUES (?, ?, 'unknown', 'run_command', 'side_effect', ?, ?, ?, 'ask', 2, '{}', ?, ?)`,
      ).run(
        toolCallId,
        runId,
        '{"args":[],"program":"node"}',
        '{"args":[],"program":"node"}',
        "original-digest",
        occurredAt,
        occurredAt,
      );
      connection.db.prepare(
        `UPDATE runs SET state = 'waiting_reconciliation', lease_owner = NULL,
           lease_expires_at = NULL, active_started_at = NULL WHERE run_id = ?`,
      ).run(runId);

      const service = new ReconcileToolCallService({
        tools,
        runs,
        policy: new PolicyEngine(),
        clock,
        ids,
      });
      const result = service.execute({
        toolCallId,
        outcome,
        note: "checked externally",
        result: { observed: true },
      });

      expect(result.toolCall.state).toBe(outcome);
      expect(runs.getRun(runId).state).toBe("queued");
      expect(tools.getLatestForRun(runId)?.result).toMatchObject({
        ok: outcome === "succeeded",
        content: {
          source: "operator",
          untrusted: true,
          note: "checked externally",
          result: { observed: true },
        },
      });
      expect(runs.listEventsAfter(runId, 0).map((event) => event.type)).toEqual(
        expect.arrayContaining([
          outcome === "succeeded" ? "tool.completed" : "tool.failed",
          "run.queued",
        ]),
      );
    } finally {
      connection.close();
    }
    },
  );

  it("creates one policy-checked retry and a fresh Approval without rewriting the unknown call", () => {
    const connection = openDatabase({
      path: tempPath("reconcile-retry.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const tools = new SqliteToolRepository(connection.db);
      const approvals = new SqliteApprovalRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const runId = runIdFromUuid("00000000-0000-7000-8000-000000000402");
      const originalCallId = toolCallIdFromUuid(
        "00000000-0000-7000-8000-000000000402",
      );
      const retryCallId = toolCallIdFromUuid(
        "00000000-0000-7000-8000-000000000403",
      );
      const approvalId = approvalIdFromUuid(
        "00000000-0000-7000-8000-000000000402",
      );
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000402")],
        runIds: [runId],
        toolCallIds: [
          retryCallId,
          toolCallIdFromUuid("00000000-0000-7000-8000-000000000404"),
        ],
        approvalIds: [
          approvalId,
          approvalIdFromUuid("00000000-0000-7000-8000-000000000403"),
        ],
      });
      new CreateRunService(resolvedAgents(new CatalogService(snapshot)), runs, clock, ids).execute({
        agentId: "primary",
        sessionKey: "reconcile:retry",
        input: { type: "text", text: "retry only after I approve" },
        idempotencyKey: "reconcile-retry-0001",
        source: { kind: "http" },
      });
      runs.claimNextEligible(
        "seed-worker",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const occurredAt = clock.now().toISOString();
      connection.db.prepare(
        `INSERT INTO tool_calls (
           tool_call_id, run_id, state, tool_name, effect, arguments_json,
           canonical_arguments, arguments_sha256, policy_effect, matched_rule,
           policy_facts_json, created_at, updated_at
         ) VALUES (?, ?, 'unknown', 'run_command', 'side_effect', ?, ?, ?, 'ask', 2, '{}', ?, ?)`,
      ).run(
        originalCallId,
        runId,
        '{"args":[],"program":"node"}',
        '{"args":[],"program":"node"}',
        "retry-digest",
        occurredAt,
        occurredAt,
      );
      connection.db.prepare(
        `UPDATE runs SET state = 'waiting_reconciliation', lease_owner = NULL,
           lease_expires_at = NULL, active_started_at = NULL WHERE run_id = ?`,
      ).run(runId);
      const service = new ReconcileToolCallService({
        tools,
        runs,
        policy: new PolicyEngine(),
        clock,
        ids,
      });

      const first = service.execute({
        toolCallId: originalCallId,
        outcome: "retry",
        note: "the command did not start",
      });
      const again = service.execute({
        toolCallId: originalCallId,
        outcome: "retry",
        note: "the command did not start",
      });

      expect(first.retryToolCallId).toBe(retryCallId);
      expect(again.retryToolCallId).toBe(retryCallId);
      expect(tools.get(originalCallId).state).toBe("unknown");
      expect(tools.get(retryCallId)).toMatchObject({
        state: "waiting_approval",
        retryOfToolCallId: originalCallId,
        argumentsSha256: "retry-digest",
        policyEffect: "ask",
      });
      expect(runs.getRun(runId).state).toBe("waiting_approval");
      expect(approvals.getPendingForRun(runId)).toMatchObject({
        approvalId,
        toolCallId: retryCallId,
        argumentsSha256: "retry-digest",
      });
      expect(
        connection.db.prepare(
          "SELECT COUNT(*) AS count FROM tool_calls WHERE retry_of_tool_call_id = ?",
        ).get(originalCallId),
      ).toEqual({ count: 1 });
    } finally {
      connection.close();
    }
  });

  it("resumes after restart with only the immutable approved arguments", async () => {
    const databasePath = tempPath("approval-restart.db");
    const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
    const runId = runIdFromUuid("00000000-0000-7000-8000-000000000405");
    const toolCallId = toolCallIdFromUuid(
      "00000000-0000-7000-8000-000000000405",
    );
    const approvalId = approvalIdFromUuid(
      "00000000-0000-7000-8000-000000000405",
    );
    const approvedArguments = { args: ["-e", "process.exit(0)"], program: "node" };

    const first = openDatabase({ path: databasePath, busyTimeoutMs: 5_000 });
    try {
      migrate(first.db);
      const catalog = new SqliteCatalogRepository(first.db);
      const runs = new SqliteRunRepository(first.db, catalog);
      const sessions = new SqliteSessionRepository(first.db);
      const tools = new SqliteToolRepository(first.db);
      const approvals = new SqliteApprovalRepository(first.db);
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000405")],
        runIds: [runId],
        toolCallIds: [toolCallId],
        approvalIds: [approvalId],
        attemptIds: ["att_00000000-0000-7000-8000-000000000405" as never],
      });
      new CreateRunService(resolvedAgents(new CatalogService(snapshot)), runs, clock, ids).execute({
        agentId: "primary",
        sessionKey: "approval:restart",
        input: { type: "text", text: "run the approved command" },
        idempotencyKey: "approval-restart-0001",
        source: { kind: "http" },
      });
      runs.claimNextEligible(
        "before-restart",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const model = new ScriptedModel();
      model.script({
        chunks: [
          {
            type: "tool_call",
            callId: "provider_approval_restart",
            name: "run_command",
            arguments: { command: "ignored raw form" },
          },
          {
            type: "completed",
            finishReason: "tool_call",
            usage: { inputTokens: 10, outputTokens: 2 },
          },
        ],
      });
      const registry = new ToolRegistry();
      registry.register({
        name: "run_command",
        effect: "side_effect",
        async parseAndNormalize() {
          return { arguments: approvedArguments, policyFacts: {} };
        },
        async execute() {
          throw new Error("must_not_execute_before_approval");
        },
      });
      const advance = new AdvanceRunService({
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
        modelRegistry: noOpProviderHealthSink,
      });

      expect(await advance.advance(
        runId,
        "before-restart",
        new AbortController().signal,
      )).toMatchObject({ type: "waiting", state: "waiting_approval" });
      expect(approvals.getPendingForRun(runId)?.argumentsSha256).toBe(
        tools.get(toolCallId).argumentsSha256,
      );
    } finally {
      first.close();
    }

    const second = openDatabase({ path: databasePath, busyTimeoutMs: 5_000 });
    try {
      migrate(second.db);
      const catalog = new SqliteCatalogRepository(second.db);
      const runs = new SqliteRunRepository(second.db, catalog);
      const sessions = new SqliteSessionRepository(second.db);
      const tools = new SqliteToolRepository(second.db);
      const approvals = new SqliteApprovalRepository(second.db);
      const decisions = new DecideApprovalService(approvals, clock);
      const firstDecision = await decisions.execute({
        approvalId,
        decision: "approve",
      });
      await expect(decisions.execute({ approvalId, decision: "approve" })).resolves.toEqual(
        firstDecision,
      );
      await expect(decisions.execute({ approvalId, decision: "deny" })).rejects.toThrowError(
        expect.objectContaining({ code: "approval_already_resolved", status: 409 }),
      );
      runs.claimNextEligible(
        "after-restart",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      let executedArguments: unknown;
      const registry = new ToolRegistry();
      registry.register({
        name: "run_command",
        effect: "side_effect",
        async parseAndNormalize() {
          throw new Error("must_not_renormalize_approved_arguments");
        },
        async execute(argumentsValue) {
          executedArguments = argumentsValue;
          return {
            ok: true,
            summary: "approved command completed",
            content: { exitCode: 0 },
            capturedBytes: 0,
            truncated: false,
          };
        },
      });
      const advance = new AdvanceRunService({
        runs,
        tools,
        approvals,
        sessions,
        model: new ScriptedModel(),
        prompts: new PromptAssembler(sessions),
        registry,
        policy: new PolicyEngine(),
        clock,
        ids: new FakeIds(),
        modelRegistry: noOpProviderHealthSink,
      });

      expect(await advance.advance(
        runId,
        "after-restart",
        new AbortController().signal,
      )).toEqual({ type: "advanced", runId });
      expect(executedArguments).toEqual(approvedArguments);
      expect(tools.get(toolCallId)).toMatchObject({
        state: "succeeded",
        arguments: approvedArguments,
      });
    } finally {
      second.close();
    }
  });

  it("expires a pending Approval through the denial transaction exactly once", async () => {
    const connection = openDatabase({
      path: tempPath("approval-expiry.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const catalog = new SqliteCatalogRepository(connection.db);
      const runs = new SqliteRunRepository(connection.db, catalog);
      const approvals = new SqliteApprovalRepository(connection.db);
      const tools = new SqliteToolRepository(connection.db);
      const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
      const runId = runIdFromUuid("00000000-0000-7000-8000-000000000406");
      const toolCallId = toolCallIdFromUuid(
        "00000000-0000-7000-8000-000000000406",
      );
      const approvalId = approvalIdFromUuid(
        "00000000-0000-7000-8000-000000000406",
      );
      const ids = new FakeIds({
        sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000406")],
        runIds: [runId],
      });
      new CreateRunService(resolvedAgents(new CatalogService(snapshot)), runs, clock, ids).execute({
        agentId: "primary",
        sessionKey: "approval:expiry",
        input: { type: "text", text: "let the Approval expire" },
        idempotencyKey: "approval-expiry-0001",
        source: { kind: "http" },
      });
      runs.claimNextEligible(
        "seed-worker",
        clock.now(),
        new Date(clock.now().getTime() + 30_000),
      );
      const occurredAt = clock.now().toISOString();
      connection.db.prepare(
        `INSERT INTO tool_calls (
           tool_call_id, run_id, state, tool_name, effect, arguments_json,
           canonical_arguments, arguments_sha256, policy_effect, matched_rule,
           policy_facts_json, created_at, updated_at
         ) VALUES (?, ?, 'waiting_approval', 'run_command', 'side_effect',
           '{}', '{}', 'expiry-digest', 'ask', 2, '{}', ?, ?)`,
      ).run(toolCallId, runId, occurredAt, occurredAt);
      connection.db.prepare(
        `INSERT INTO approvals (
           approval_id, run_id, tool_call_id, state, arguments_sha256,
           expires_at, created_at
         ) VALUES (?, ?, ?, 'pending', 'expiry-digest', ?, ?)`,
      ).run(approvalId, runId, toolCallId, occurredAt, occurredAt);
      connection.db.prepare(
        `UPDATE runs SET state = 'waiting_approval', lease_owner = NULL,
           lease_expires_at = NULL, active_started_at = NULL WHERE run_id = ?`,
      ).run(runId);
      const expirer = new ApprovalExpirer({ approvals, clock });

      await expirer.scan();
      const eventCount = runs.listEventsAfter(runId, 0).length;
      await expirer.scan();

      expect(runs.getRun(runId).state).toBe("queued");
      expect(tools.get(toolCallId)).toMatchObject({
        state: "denied",
        result: {
          ok: false,
          code: "tool_denied",
          reason: "approval_expired",
        },
      });
      expect(
        connection.db.prepare(
          `SELECT state, resolution_reason FROM approvals WHERE approval_id = ?`,
        ).get(approvalId),
      ).toEqual({ state: "expired", resolution_reason: "approval_expired" });
      expect(runs.listEventsAfter(runId, 0)).toHaveLength(eventCount);
    } finally {
      connection.close();
    }
  });
});

function seedTuiApproval(db: import("node:sqlite").DatabaseSync, runId: string): void {
  const now = "2026-08-07T00:00:00.000Z";
  db.prepare("UPDATE runs SET state = 'waiting_approval' WHERE run_id = ?").run(runId);
  db.prepare(`INSERT INTO tool_calls (
    tool_call_id, run_id, state, tool_name, effect, arguments_json,
    canonical_arguments, arguments_sha256, policy_effect, matched_rule,
    policy_facts_json, created_at, updated_at
  ) VALUES ('tool-tui-1', ?, 'waiting_approval', 'run_command', 'side_effect',
    ?, ?, 'hash-tui-1', 'ask', 0, '{}', ?, ?)`)
    .run(runId, '{"args":["status"],"program":"git"}', '{"args":["status"],"program":"git"}', now, now);
  db.prepare(`INSERT INTO approvals (
    approval_id, run_id, tool_call_id, state, arguments_sha256, expires_at, created_at
  ) VALUES ('approval-tui-1', ?, 'tool-tui-1', 'pending', 'hash-tui-1', ?, ?)`)
    .run(runId, "2026-08-13T00:00:00.000Z", now);
}
