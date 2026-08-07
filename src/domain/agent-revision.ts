import type { SecretRef } from "../config/secret-ref.js";
import type { AgentId } from "./ids.js";
import type { RunLimits } from "./limits.js";

export type PolicyEffect = "allow" | "ask" | "deny";

export interface SkillSnapshot {
  name: string;
  description: string;
  version: number;
  requiredTools: readonly string[];
  body: string;
  contentSha256: string;
}

export type PolicyWhen =
  | { pathWithinWorkspace: true }
  | { targetAgentInDelegates: true };

export interface PolicyRule {
  agent?: AgentId | "*";
  tool: string;
  when?: PolicyWhen;
  effect: PolicyEffect;
}

export interface AgentRevisionSnapshot {
  revisionId: string;
  agentId: AgentId;
  displayName: string;
  prompt: string;
  model: {
    provider: string;
    model: string;
    baseUrl: string;
    apiKey: SecretRef;
    maxInputTokens: number;
  };
  workspace: string;
  skills: readonly SkillSnapshot[];
  policy: readonly PolicyRule[];
  delegates: readonly AgentId[];
  limits: RunLimits;
  contentSha256: string;
}
