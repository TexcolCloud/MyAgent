import type { AgentId } from "./ids.js";

export type PolicyEffect = "allow" | "ask" | "deny";

export type PolicyWhen =
  | { pathWithinWorkspace: true }
  | { targetAgentInDelegates: true };

export interface PolicyRule {
  agent?: AgentId | "*";
  tool: string;
  when?: PolicyWhen;
  effect: PolicyEffect;
}

export interface PolicyFacts {
  pathWithinWorkspace?: true;
  targetAgentInDelegates?: true;
}

export interface PolicyEvaluationContext {
  agentId: AgentId;
  toolName: string;
  policy: readonly PolicyRule[];
  policyFacts: Readonly<PolicyFacts>;
  requiredTools?: readonly string[];
}

export interface PolicyDecision {
  effect: PolicyEffect;
  matchedRule: number | null;
}
