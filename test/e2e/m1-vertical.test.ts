import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  AgentHttpClient,
  countChildRuns,
  E2eServiceController,
  prepareE2eFixture,
  readToolResult,
  ScriptedChatServer,
  type ProviderTurn,
} from "../helpers/fault-controller.js";

describe("M1 vertical slice", () => {
  it("completes HTTP -> Skill -> allow -> Approval -> restart -> Tool -> response -> child Run", async () => {
    const turns: ProviderTurn[] = [
      { type: "tool", name: "activate_skill", arguments: { skillName: "research" } },
      { type: "tool", name: "list_files", arguments: { path: ".", glob: "**/*", maxEntries: 20 } },
      { type: "tool", name: "read_file", arguments: { path: "evidence.txt" } },
      {
        type: "tool",
        name: "write_file",
        arguments: { path: "report.md", content: "verified report\n", expectedSha256: null },
      },
      {
        type: "tool",
        name: "run_command",
        arguments: {
          program: process.execPath,
          args: ["-e", "process.stdout.write('command-ok')"],
          cwd: ".",
          env: {},
          timeoutMs: 5_000,
        },
      },
      {
        type: "tool",
        name: "delegate_agent",
        arguments: { targetAgentId: "researcher", task: "Review the report.", context: {} },
      },
      { type: "text", text: "child review complete" },
      { type: "text", text: "primary final response" },
    ];
    const provider = await ScriptedChatServer.start(turns);
    const fixture = await prepareE2eFixture(provider.baseUrl);
    const service = new E2eServiceController(fixture.configPath);
    const client = new AgentHttpClient(() => service.url);

    try {
      await service.start();
      const run = await client.createRun({
        agentId: "primary",
        sessionKey: "e2e:main",
        text: "Use the research Skill, inspect the Workspace, write the report, then delegate review.",
        idempotencyKey: "e2e-request-0001",
      });
      const activated = await client.waitForEvent(run.runId, "skill.activated");
      const approvalRequired = await client.waitForEvent(
        run.runId,
        "approval.required",
        activated.sequence,
      );

      await service.restart();
      const approval = await client.onlyPendingApproval();
      expect(approval.runId).toBe(run.runId);
      await client.approve(approval.approvalId);

      const terminal = await client.waitForEvent(
        run.runId,
        "run.completed",
        approvalRequired.sequence,
        30_000,
      );
      expect(terminal.payload).toMatchObject({ result: "primary final response" });
      expect(await client.getRun(run.runId)).toMatchObject({ status: "completed" });
      expect(countChildRuns(fixture.databasePath, run.runId)).toBe(1);
      expect(await readFile(path.join(fixture.primaryWorkspace, "report.md"), "utf8"))
        .toBe("verified report\n");
      expect(readToolResult(fixture.databasePath, "run_command")).toContain("command-ok");
      expect(provider.requests).toHaveLength(turns.length);
    } finally {
      await service.stop();
      await fixture.cleanup();
      await provider.close();
    }
  }, 45_000);
});
