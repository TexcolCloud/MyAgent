import type {
  PolicyDecision,
  PolicyEvaluationContext,
  PolicyFacts,
  PolicyRule,
  PolicyWhen,
} from "../domain/policy.js";

export class PolicyEngine {
  decide(context: PolicyEvaluationContext): PolicyDecision {
    for (const [index, rule] of context.policy.entries()) {
      if (matchesRule(rule, context)) {
        return { effect: rule.effect, matchedRule: index };
      }
    }

    return { effect: "deny", matchedRule: null };
  }
}

function matchesRule(
  rule: PolicyRule,
  context: PolicyEvaluationContext,
): boolean {
  return (
    matchesAgent(rule, context.agentId) &&
    (rule.tool === "*" || rule.tool === context.toolName) &&
    matchesPredicate(rule.when, context.policyFacts)
  );
}

function matchesAgent(
  rule: PolicyRule,
  agentId: PolicyEvaluationContext["agentId"],
): boolean {
  return rule.agent === undefined || rule.agent === "*" || rule.agent === agentId;
}

function matchesPredicate(
  when: PolicyWhen | undefined,
  facts: Readonly<PolicyFacts>,
): boolean {
  if (when === undefined) {
    return true;
  }
  if ("pathWithinWorkspace" in when) {
    return facts.pathWithinWorkspace === true;
  }
  return facts.targetAgentInDelegates === true;
}
