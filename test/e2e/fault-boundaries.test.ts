import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DecideApprovalService } from "../../src/application/decide-approval.js";
import type { ApprovalId, RunId, ToolCallId } from "../../src/domain/ids.js";
import type { FaultInjector, FaultPoint } from "../../src/runtime/fault-injector.js";
import {
  AgentHttpClient,
  E2eServiceController,
  FaultChildController,
  prepareE2eFixture,
  ScriptedChatServer,
  type ProviderTurn,
} from "../helpers/fault-controller.js";

const APPROVAL_ID = "approval_00000000-0000-7000-8000-000000000001" as ApprovalId;

describe("durable fault boundaries", () => {
  it("places Approval fault hooks on opposite sides of the durable decision", async () => {
    const approval = {
      approvalId: APPROVAL_ID,
      runId: "run_00000000-0000-7000-8000-000000000001" as RunId,
      toolCallId: "tool_00000000-0000-7000-8000-000000000001" as ToolCallId,
      state: "approved" as const,
      argumentsSha256: "a".repeat(64),
      expiresAt: new Date(1),
      resolvedAt: new Date(0),
      resolutionReason: "approved",
      createdAt: new Date(0),
    };
    const decide = vi.fn(() => approval);

    await expect(new DecideApprovalService(
      { decide },
      { now: () => new Date(0) },
      throwingAt("before_approval_resolution"),
    ).execute({ approvalId: APPROVAL_ID, decision: "approve" })).rejects.toThrow(
      "fault:before_approval_resolution",
    );
    expect(decide).not.toHaveBeenCalled();

    await expect(new DecideApprovalService(
      { decide },
      { now: () => new Date(0) },
      throwingAt("after_approval_resolution"),
    ).execute({ approvalId: APPROVAL_ID, decision: "approve" })).rejects.toThrow(
      "fault:after_approval_resolution",
    );
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      point: "before_run_claim" as const,
      turns: [{ type: "text" as const, text: "completed after queued recovery" }],
      expectedRequestsAtCrash: 0,
      expectedRequestsAtCompletion: 1,
      pauseBeforeCreate: true,
    },
    {
      point: "after_run_claim" as const,
      turns: [{ type: "text" as const, text: "completed after lease recovery" }],
      expectedRequestsAtCrash: 0,
      expectedRequestsAtCompletion: 1,
      pauseBeforeCreate: false,
    },
    {
      point: "before_model_attempt_commit" as const,
      turns: [
        { type: "text" as const, text: "abandoned provider output" },
        { type: "text" as const, text: "completed after attempt recovery" },
      ],
      expectedRequestsAtCrash: 1,
      expectedRequestsAtCompletion: 2,
      pauseBeforeCreate: false,
    },
    {
      point: "after_model_attempt_commit" as const,
      turns: [{ type: "text" as const, text: "durably completed before crash" }],
      expectedRequestsAtCrash: 1,
      expectedRequestsAtCompletion: 1,
      pauseBeforeCreate: false,
    },
  ])("recovers a Run interrupted at $point", async ({
    point,
    turns,
    expectedRequestsAtCrash,
    expectedRequestsAtCompletion,
    pauseBeforeCreate,
  }) => {
    const provider = await ScriptedChatServer.start(turns);
    const fixture = await prepareE2eFixture(provider.baseUrl);
    const child = new FaultChildController(fixture, point);
    const recovery = new E2eServiceController(fixture.configPath);
    const faultClient = new AgentHttpClient(() => child.url);
    const recoveryClient = new AgentHttpClient(() => recovery.url);

    try {
      await child.start();
      await child.arm();
      if (pauseBeforeCreate) await child.waitForHit();
      const run = await faultClient.createRun({
        agentId: "primary",
        sessionKey: `fault:${point}`,
        text: "complete across a process crash",
        idempotencyKey: `fault-${point}-0001`,
      });
      if (!pauseBeforeCreate) await child.waitForHit();
      expect(provider.requests).toHaveLength(expectedRequestsAtCrash);
      await child.crash();

      await waitForLeaseExpiry();
      await recovery.start();
      await recoveryClient.waitForStatus(run.runId, "completed", 20_000);
      expect(provider.requests).toHaveLength(expectedRequestsAtCompletion);
    } finally {
      await child.stop();
      await recovery.stop();
      await fixture.cleanup();
      await provider.close();
    }
  }, 30_000);

  it.each([
    { point: "before_tool_execution" as const, expectedState: "completed", expectedRequests: 2 },
    { point: "after_tool_execution" as const, expectedState: "waiting_reconciliation", expectedRequests: 1 },
  ])("does not duplicate a side effect interrupted at $point", async ({
    point,
    expectedState,
    expectedRequests,
  }) => {
    const command = "require('node:fs').appendFileSync('effect.log','effect\\n');process.stdout.write('done')";
    const turns: ProviderTurn[] = [
      {
        type: "tool",
        name: "run_command",
        arguments: {
          program: process.execPath,
          args: ["-e", command],
          cwd: ".",
          env: {},
          timeoutMs: 5_000,
        },
      },
      ...(point === "before_tool_execution"
        ? [{ type: "text" as const, text: "completed after safe retry" }]
        : []),
    ];
    const provider = await ScriptedChatServer.start(turns);
    const fixture = await prepareE2eFixture(provider.baseUrl);
    const child = new FaultChildController(fixture, point);
    const recovery = new E2eServiceController(fixture.configPath);
    const faultClient = new AgentHttpClient(() => child.url);
    const recoveryClient = new AgentHttpClient(() => recovery.url);
    const effectPath = path.join(fixture.primaryWorkspace, "effect.log");

    try {
      await child.start();
      await child.arm();
      const run = await faultClient.createRun({
        agentId: "primary",
        sessionKey: `fault:${point}`,
        text: "execute one known side effect",
        idempotencyKey: `fault-${point}-0001`,
      });
      await child.waitForHit();
      if (point === "before_tool_execution") expect(existsSync(effectPath)).toBe(false);
      else expect(await effectLines(effectPath)).toEqual(["effect"]);
      await child.crash();

      await waitForLeaseExpiry();
      await recovery.start();
      await recoveryClient.waitForStatus(run.runId, expectedState, 20_000);
      expect(await effectLines(effectPath)).toEqual(["effect"]);
      expect(provider.requests).toHaveLength(expectedRequests);
    } finally {
      await child.stop();
      await recovery.stop();
      await fixture.cleanup();
      await provider.close();
    }
  }, 30_000);

  it.each([
    { point: "before_approval_resolution" as const, approvalRemainsPending: true },
    { point: "after_approval_resolution" as const, approvalRemainsPending: false },
    { point: "before_worker_resume" as const, approvalRemainsPending: false },
    { point: "after_worker_resume" as const, approvalRemainsPending: false },
  ])("resumes an approved side effect once across $point", async ({
    point,
    approvalRemainsPending,
  }) => {
    const effectPathName = "approved-effect.log";
    const provider = await ScriptedChatServer.start([
      {
        type: "tool",
        name: "run_command",
        arguments: {
          program: process.execPath,
          args: [
            "-e",
            `require('node:fs').appendFileSync('${effectPathName}','approved\\n')`,
          ],
          cwd: ".",
          env: {},
          timeoutMs: 5_000,
        },
      },
      { type: "text", text: "approval recovery completed" },
    ]);
    const fixture = await prepareE2eFixture(provider.baseUrl, {
      allowRunCommand: false,
    });
    const child = new FaultChildController(fixture, point);
    const recovery = new E2eServiceController(fixture.configPath);
    const faultClient = new AgentHttpClient(() => child.url);
    const recoveryClient = new AgentHttpClient(() => recovery.url);
    const effectPath = path.join(fixture.primaryWorkspace, effectPathName);

    try {
      await child.start();
      const run = await faultClient.createRun({
        agentId: "primary",
        sessionKey: `fault:${point}`,
        text: "perform an approved side effect exactly once",
        idempotencyKey: `fault-${point}-0001`,
      });
      await faultClient.waitForEvent(run.runId, "approval.required");
      expect(existsSync(effectPath)).toBe(false);
      const approval = await faultClient.onlyPendingApproval();
      await child.arm();
      const deciding = faultClient.approve(approval.approvalId);
      const settledDecision = deciding.then(
        () => undefined,
        () => undefined,
      );
      if (point.startsWith("before_worker") || point.startsWith("after_worker")) {
        await deciding;
      }
      await child.waitForHit();
      await child.crash();
      await settledDecision;

      await waitForLeaseExpiry();
      await recovery.start();
      if (approvalRemainsPending) {
        expect(existsSync(effectPath)).toBe(false);
        const pending = await recoveryClient.onlyPendingApproval();
        expect(pending.approvalId).toBe(approval.approvalId);
        await recoveryClient.approve(pending.approvalId);
      }
      await recoveryClient.waitForStatus(run.runId, "completed", 20_000);
      expect(await effectLines(effectPath)).toEqual(["approved"]);
      expect(provider.requests).toHaveLength(2);
    } finally {
      await child.stop();
      await recovery.stop();
      await fixture.cleanup();
      await provider.close();
    }
  }, 35_000);

  it.each([
    { point: "before_sse_write" as const, deliveredSequence: 0 },
    { point: "after_sse_write" as const, deliveredSequence: 1 },
  ])("replays committed events correctly across $point", async ({
    point,
    deliveredSequence,
  }) => {
    const provider = await ScriptedChatServer.start([
      { type: "text", text: "committed SSE result" },
    ]);
    const fixture = await prepareE2eFixture(provider.baseUrl);
    const child = new FaultChildController(fixture, point);
    const recovery = new E2eServiceController(fixture.configPath);
    const faultClient = new AgentHttpClient(() => child.url);
    const recoveryClient = new AgentHttpClient(() => recovery.url);

    try {
      await child.start();
      const run = await faultClient.createRun({
        agentId: "primary",
        sessionKey: `fault:${point}`,
        text: "complete before the SSE crash",
        idempotencyKey: `fault-${point}-0001`,
      });
      await faultClient.waitForStatus(run.runId, "completed", 20_000);
      await child.arm();
      const firstDelivery = faultClient.waitForEvent(run.runId, "run.queued", 0, 10_000);
      const settledDelivery = firstDelivery.then(
        (event) => event,
        () => null,
      );
      await child.waitForHit();
      if (deliveredSequence > 0) {
        expect((await settledDelivery)?.sequence).toBe(deliveredSequence);
      }
      await child.crash();
      await settledDelivery;

      await recovery.start();
      const replay = await recoveryClient.readEventStream(run.runId, deliveredSequence);
      expect(replay.length).toBeGreaterThan(0);
      expect(replay[0]?.sequence).toBe(deliveredSequence + 1);
      expect(new Set(replay.map((event) => event.sequence)).size).toBe(replay.length);
      expect(replay.map((event) => event.type)).toContain("run.completed");
      expect(JSON.stringify(replay)).not.toContain("never-committed");
      expect(provider.requests).toHaveLength(1);
    } finally {
      await child.stop();
      await recovery.stop();
      await fixture.cleanup();
      await provider.close();
    }
  }, 30_000);
});

function throwingAt(selected: FaultPoint): FaultInjector {
  return {
    async hit(point): Promise<void> {
      if (point === selected) throw new Error(`fault:${point}`);
    },
  };
}

async function waitForLeaseExpiry(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 350));
}

async function effectLines(filePath: string): Promise<string[]> {
  const content = await readFile(filePath, "utf8");
  return content.trim().split("\n");
}
