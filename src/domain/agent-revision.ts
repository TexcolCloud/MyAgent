import type {
  AgentId,
  ModelProfileRevisionId,
  ProviderConnectionRevisionId,
} from "./ids.js";
import type { RunLimits } from "./limits.js";
import type {
  InvocationProtocol,
  ProviderKind,
} from "./model-registry.js";
import type { ModelCapability } from "./model-profile.js";
import type { ProviderAuth } from "./provider-connection.js";
import type { PolicyRule } from "./policy.js";

export interface SkillSnapshot {
  name: string;
  description: string;
  version: number;
  requiredTools: readonly string[];
  body: string;
  contentSha256: string;
}

export type { PolicyEffect, PolicyRule, PolicyWhen } from "./policy.js";

export interface AgentDefinitionRevision {
  definitionRevisionId: string;
  agentId: AgentId;
  displayName: string;
  prompt: string;
  workspace: string;
  skills: readonly SkillSnapshot[];
  policy: readonly PolicyRule[];
  delegates: readonly AgentId[];
  limits: RunLimits;
  contentSha256: string;
}

export interface EffectiveModelRuntime {
  providerConnectionRevisionId: ProviderConnectionRevisionId;
  providerKind: ProviderKind;
  baseUrl: string;
  providerAuth: ProviderAuth;
  allowInsecureHttp: boolean;
  modelId: string;
  invocationProtocol: InvocationProtocol;
  maxInputTokens: number;
  verifiedCapabilities: readonly ModelCapability[];
  compatibilityPresetVersion: string;
}

export interface AgentRevisionSnapshot
  extends Omit<AgentDefinitionRevision, "definitionRevisionId"> {
  revisionId: string;
  definitionRevisionId: string;
  modelProfileRevisionId: ModelProfileRevisionId;
  model: EffectiveModelRuntime;
}

export interface AgentResolverPort {
  resolve(agentId: AgentId): AgentRevisionSnapshot;
}
