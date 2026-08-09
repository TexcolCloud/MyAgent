import { describe, expect, it } from "vitest";

import { DelegateAgentService } from "../../src/application/delegate-agent.js";
import { delegateAgentTool } from "../../src/adapters/tools/delegate-agent.js";
import { DomainError } from "../../src/domain/errors.js";
import { parseAgentId, runIdFromUuid, sessionIdFromUuid, toolCallIdFromUuid } from "../../src/domain/ids.js";

describe("delegate_agent", () => {
  it("rejects undeclared, recursive, and excessive delegation", async () => {
    let delegationDepth = 0;
    const delegate = new DelegateAgentService({
      agents: { resolve: () => ({} as never) },
      runs: {
        getExecutionContext: () => ({
          run: {
            runId: runIdFromUuid("00000000-0000-7000-8000-000000000001"),
            rootRunId: runIdFromUuid("00000000-0000-7000-8000-000000000001"),
            delegationDepth,
          },
          revision: {
            delegates: [parseAgentId("researcher")],
            limits: { childRuns: 4, delegationDepth: 1 },
          },
        }),
        startDelegation: () => { throw new Error("unreachable"); },
      },
      clock: { now: () => new Date("2026-08-07T00:00:00.000Z") },
      ids: { sessionId: () => { throw new Error("unreachable"); }, runId: () => { throw new Error("unreachable"); } },
    });

    expect(() => delegate.execute({
      parentRunId: runIdFromUuid("00000000-0000-7000-8000-000000000001"),
      parentToolCallId: toolCallIdFromUuid("00000000-0000-7000-8000-000000000001"),
      targetAgentId: parseAgentId("not-allowed"), task: "research", context: {}, leaseOwner: "worker",
    })).toThrow(expect.objectContaining({ code: "delegate_not_allowed" }));

    delegationDepth = 1;
    expect(() => delegate.execute({
      parentRunId: runIdFromUuid("00000000-0000-7000-8000-000000000001"),
      parentToolCallId: toolCallIdFromUuid("00000000-0000-7000-8000-000000000001"),
      targetAgentId: parseAgentId("researcher"), task: "research", context: {}, leaseOwner: "worker",
    })).toThrow(expect.objectContaining({ code: "delegation_depth_exceeded" }));

    await expect(delegateAgentTool.parseAndNormalize(
      { targetAgentId: "researcher", task: "research", context: {} },
      { agentId: parseAgentId("primary"), revision: { delegates: [parseAgentId("researcher")] } as never },
    )).resolves.toMatchObject({ policyFacts: { targetAgentInDelegates: true } });
  });

  it("passes only task and context to a child Run", async () => {
    let input: unknown;
    let targetRevision: unknown;
    const childRevision = { revisionId: "rev_child" } as never;
    const delegate = new DelegateAgentService({
      agents: { resolve: () => childRevision },
      runs: {
        getExecutionContext: () => ({
          run: { runId: runIdFromUuid("00000000-0000-7000-8000-000000000001"), rootRunId: runIdFromUuid("00000000-0000-7000-8000-000000000001"), delegationDepth: 0 },
          revision: { delegates: [parseAgentId("researcher")], limits: { childRuns: 4, delegationDepth: 1 } },
        }),
        startDelegation: (value) => { input = value.input; targetRevision = value.resolveTargetRevision(); return { childRunId: runIdFromUuid("00000000-0000-7000-8000-000000000002"), childSessionId: sessionIdFromUuid("00000000-0000-7000-8000-000000000002") }; },
      },
      clock: { now: () => new Date("2026-08-07T00:00:00.000Z") },
      ids: { sessionId: () => sessionIdFromUuid("00000000-0000-7000-8000-000000000002"), runId: () => runIdFromUuid("00000000-0000-7000-8000-000000000002") },
    });

    await delegate.execute({
      parentRunId: runIdFromUuid("00000000-0000-7000-8000-000000000001"), parentToolCallId: toolCallIdFromUuid("00000000-0000-7000-8000-000000000001"), targetAgentId: parseAgentId("researcher"), task: "research only this", context: { subject: "delegation" }, leaseOwner: "worker",
    });

    expect(input).toEqual({ type: "text", text: JSON.stringify({ task: "research only this", context: { subject: "delegation" } }) });
    expect(targetRevision).toBe(childRevision);
  });
});

void DomainError;
