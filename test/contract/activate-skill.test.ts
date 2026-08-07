import { describe, expect, it } from "vitest";

import { activateSkillTool } from "../../src/adapters/tools/activate-skill.js";
import type { AgentRevisionSnapshot } from "../../src/domain/agent-revision.js";
import {
  parseAgentId,
  runIdFromUuid,
  toolCallIdFromUuid,
} from "../../src/domain/ids.js";
import { DEFAULT_RUN_LIMITS } from "../../src/domain/limits.js";
import type { ToolExecutionContext } from "../../src/ports/tool.js";

describe("activate_skill Tool", () => {
  it("activates only a Skill snapshotted in the Run revision", async () => {
    const revision = revisionFixture();
    const normalized = await activateSkillTool.parseAndNormalize(
      { skillName: "research" },
      { agentId: revision.agentId, revision },
    );

    expect(normalized).toEqual({
      arguments: { skillName: "research" },
      policyFacts: {},
    });
    await expect(
      activateSkillTool.parseAndNormalize(
        { skillName: "not-snapshotted" },
        { agentId: revision.agentId, revision },
      ),
    ).rejects.toMatchObject({ code: "skill_not_available" });
  });

  it("delegates idempotent persistence to the execution callback", async () => {
    const revision = revisionFixture();
    const activated = new Set<string>();
    let persistedEvents = 0;
    const context: ToolExecutionContext = {
      agentId: revision.agentId,
      revision,
      runId: runIdFromUuid("00000000-0000-7000-8000-000000000001"),
      toolCallId: toolCallIdFromUuid(
        "00000000-0000-7000-8000-000000000001",
      ),
      signal: new AbortController().signal,
      remainingRunOutputBytes: 1_024,
      activateSkill(skillName) {
        if (!activated.has(skillName)) {
          activated.add(skillName);
          persistedEvents += 1;
        }
      },
    };

    const first = await activateSkillTool.execute(
      { skillName: "research" },
      context,
    );
    const second = await activateSkillTool.execute(
      { skillName: "research" },
      context,
    );

    expect(first).toEqual(second);
    expect(first.content).toEqual({ skillName: "research", activated: true });
    expect(activated).toEqual(new Set(["research"]));
    expect(persistedEvents).toBe(1);
  });
});

function revisionFixture(): AgentRevisionSnapshot {
  const agentId = parseAgentId("primary");
  return {
    revisionId: "rev_activate_skill",
    agentId,
    displayName: "Primary",
    prompt: "Primary Agent",
    model: {
      provider: "openai-compatible",
      model: "test-model",
      baseUrl: "https://example.invalid/v1",
      apiKey: { fromEnvironment: "TEST_API_KEY" },
      maxInputTokens: 8_192,
    },
    workspace: "C:/workspace",
    skills: [
      {
        name: "research",
        description: "Research carefully",
        version: 1,
        requiredTools: ["read_file"],
        body: "Use primary sources.",
        contentSha256: "1".repeat(64),
      },
    ],
    policy: [],
    delegates: [],
    limits: DEFAULT_RUN_LIMITS,
    contentSha256: "0".repeat(64),
  };
}
