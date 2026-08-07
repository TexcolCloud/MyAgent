import { describe, expect, it } from "vitest";

import { PolicyEngine } from "../../src/application/policy-engine.js";
import { parseAgentId } from "../../src/domain/ids.js";
import type {
  PolicyEvaluationContext,
  PolicyRule,
} from "../../src/domain/policy.js";

const engine = new PolicyEngine();
const primary = parseAgentId("primary");

describe("PolicyEngine", () => {
  it("uses the first match and denies unmatched calls", () => {
    const policy = policyFixture([
      { tool: "read_file", effect: "ask" },
      { tool: "read_file", effect: "allow" },
    ]);

    expect(engine.decide(context({ toolName: "read_file", policy }))).toEqual({
      effect: "ask",
      matchedRule: 0,
    });
    expect(engine.decide(context({ toolName: "unlisted", policy }))).toEqual({
      effect: "deny",
      matchedRule: null,
    });
  });

  it("does not treat requiredTools as permission", () => {
    expect(
      engine.decide(
        context({
          toolName: "run_command",
          requiredTools: ["run_command"],
          policy: policyFixture([]),
        }),
      ),
    ).toEqual({ effect: "deny", matchedRule: null });
  });

  it("matches exact and wildcard Agent and Tool selectors in order", () => {
    const policy = policyFixture([
      {
        agent: parseAgentId("researcher"),
        tool: "read_file",
        effect: "allow",
      },
      { agent: "*", tool: "read_file", effect: "ask" },
      { tool: "*", effect: "deny" },
    ]);

    expect(engine.decide(context({ policy }))).toEqual({
      effect: "ask",
      matchedRule: 1,
    });
  });

  it("matches path rules only from trusted normalized facts", () => {
    const policy = policyFixture([
      {
        tool: "read_file",
        when: { pathWithinWorkspace: true },
        effect: "allow",
      },
      { tool: "read_file", effect: "deny" },
    ]);

    expect(engine.decide(context({ policy }))).toEqual({
      effect: "deny",
      matchedRule: 1,
    });
    expect(
      engine.decide(
        context({ policy, policyFacts: { pathWithinWorkspace: true } }),
      ),
    ).toEqual({ effect: "allow", matchedRule: 0 });
  });

  it("matches delegation rules only from the delegate allowlist fact", () => {
    const policy = policyFixture([
      {
        tool: "delegate_agent",
        when: { targetAgentInDelegates: true },
        effect: "allow",
      },
    ]);

    expect(
      engine.decide(context({ toolName: "delegate_agent", policy })),
    ).toEqual({ effect: "deny", matchedRule: null });
    expect(
      engine.decide(
        context({
          toolName: "delegate_agent",
          policy,
          policyFacts: { targetAgentInDelegates: true },
        }),
      ),
    ).toEqual({ effect: "allow", matchedRule: 0 });
  });
});

function policyFixture(rules: readonly PolicyRule[]): readonly PolicyRule[] {
  return rules;
}

function context(
  overrides: Partial<PolicyEvaluationContext> = {},
): PolicyEvaluationContext {
  return {
    agentId: primary,
    toolName: "read_file",
    policy: [],
    policyFacts: {},
    ...overrides,
  };
}
