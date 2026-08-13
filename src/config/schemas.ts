import { z } from "zod";

import {
  environmentSecretRefSchema,
  secretRefSchema,
} from "./secret-ref.js";

const AGENT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const uniqueStrings = <T extends z.ZodType<string[]>>(schema: T): T =>
  schema.refine((values) => new Set(values).size === values.length, {
    message: "duplicate values are not allowed",
  }) as T;

export const modelConfigSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: secretRefSchema,
  maxInputTokens: z.number().int().positive(),
});

export const globalConfigSchema = z.strictObject({
  server: z.strictObject({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65_535).default(8787),
    bearerToken: secretRefSchema,
  }),
  database: z.strictObject({
    path: z.string().min(1),
    busyTimeoutMs: z.number().int().positive().default(5_000),
  }),
  agentRoots: z.array(z.string().min(1)).min(1),
  skillRoots: z.array(z.string().min(1)).default([]),
  models: z.record(z.string().min(1), modelConfigSchema),
  toolEnvironmentAllowlist: uniqueStrings(
    z.array(z.string().regex(ENVIRONMENT_NAME_PATTERN)).default([]),
  ),
});

export const runLimitsOverrideSchema = z.strictObject({
  modelTurns: z.number().int().positive().optional(),
  toolCalls: z.number().int().positive().optional(),
  childRuns: z.number().int().nonnegative().optional(),
  delegationDepth: z.number().int().nonnegative().optional(),
  activeExecutionSeconds: z.number().positive().optional(),
  defaultToolTimeoutMs: z.number().int().positive().optional(),
  maxToolTimeoutMs: z.number().int().positive().optional(),
  maxToolOutputBytes: z.number().int().positive().optional(),
  maxRunToolOutputBytes: z.number().int().positive().optional(),
});

export const agentConfigV1Schema = z.strictObject({
  id: z.string().regex(AGENT_ID_PATTERN),
  displayName: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().min(1),
  workspace: z.string().min(1),
  skills: uniqueStrings(z.array(z.string().min(1)).default([])),
  policy: z.string().min(1),
  delegates: uniqueStrings(z.array(z.string().regex(AGENT_ID_PATTERN)).default([])),
  limits: runLimitsOverrideSchema.default({}),
});

export const agentConfigSchema = agentConfigV1Schema;

const modelControlConfigSchema = z.strictObject({
  discoveryCacheSeconds: z.number().int().positive().default(600),
  discoveryTimeoutMs: z.number().int().positive().default(10_000),
  verificationRequestTimeoutMs: z.number().int().positive().default(30_000),
  verificationJobTimeoutMs: z.number().int().positive().default(120_000),
  maxDiscoveredModels: z.number().int().positive().default(1_000),
  maxDiscoveryResponseBytes: z.number().int().positive().default(2_097_152),
  verificationConcurrency: z.number().int().positive().default(1),
});

export const globalConfigV2Schema = z.strictObject({
  version: z.literal(2),
  server: z.strictObject({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65_535).default(8787),
    bearerToken: environmentSecretRefSchema,
    adminToken: environmentSecretRefSchema,
  }),
  database: z.strictObject({
    path: z.string().min(1),
    busyTimeoutMs: z.number().int().positive().default(5_000),
  }),
  agentRoots: z.array(z.string().min(1)).min(1),
  skillRoots: z.array(z.string().min(1)).default([]),
  toolEnvironmentAllowlist: uniqueStrings(
    z.array(z.string().regex(ENVIRONMENT_NAME_PATTERN)).default([]),
  ),
  modelControl: modelControlConfigSchema.default({
    discoveryCacheSeconds: 600,
    discoveryTimeoutMs: 10_000,
    verificationRequestTimeoutMs: 30_000,
    verificationJobTimeoutMs: 120_000,
    maxDiscoveredModels: 1_000,
    maxDiscoveryResponseBytes: 2_097_152,
    verificationConcurrency: 1,
  }),
});

/** The intentionally model-free configuration written for a new local project. */
export const localProjectConfigSchema = globalConfigV2Schema.omit({
  modelControl: true,
});

export const agentConfigV2Schema = z.strictObject({
  id: z.string().regex(AGENT_ID_PATTERN),
  displayName: z.string().min(1),
  prompt: z.string().min(1),
  workspace: z.string().min(1),
  skills: uniqueStrings(z.array(z.string().min(1)).default([])),
  policy: z.string().min(1),
  delegates: uniqueStrings(z.array(z.string().regex(AGENT_ID_PATTERN)).default([])),
  limits: runLimitsOverrideSchema.default({}),
});

const legacyModelConfigSchema = z.strictObject({
  provider: z.enum(["openai", "deepseek", "openai_compatible"]),
  model: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: environmentSecretRefSchema,
  maxInputTokens: z.number().int().positive(),
});

export const legacyGlobalConfigV1Schema = z.strictObject({
  version: z.literal(1).optional(),
  server: z.strictObject({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65_535).default(8787),
    bearerToken: environmentSecretRefSchema,
    adminToken: environmentSecretRefSchema,
  }),
  database: z.strictObject({
    path: z.string().min(1),
    busyTimeoutMs: z.number().int().positive().default(5_000),
  }),
  agentRoots: z.array(z.string().min(1)).min(1),
  skillRoots: z.array(z.string().min(1)).default([]),
  models: z.record(z.string().min(1), legacyModelConfigSchema),
  toolEnvironmentAllowlist: uniqueStrings(
    z.array(z.string().regex(ENVIRONMENT_NAME_PATTERN)).default([]),
  ),
}).transform((config) => ({ ...config, version: 1 as const }));

export const policyWhenSchema = z.union([
  z.strictObject({ pathWithinWorkspace: z.literal(true) }),
  z.strictObject({ targetAgentInDelegates: z.literal(true) }),
]);

export const policyRuleSchema = z.strictObject({
  agent: z.union([z.string().regex(AGENT_ID_PATTERN), z.literal("*")]).optional(),
  tool: z.string().min(1),
  when: policyWhenSchema.optional(),
  effect: z.enum(["allow", "ask", "deny"]),
});

export const policyConfigSchema = z.strictObject({
  version: z.literal(1),
  rules: z.array(policyRuleSchema),
});

export const skillFrontmatterSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.number().int().positive(),
  requiredTools: uniqueStrings(z.array(z.string().min(1)).default([])),
});

export type GlobalConfig = z.infer<typeof globalConfigSchema>;
export type AgentConfigV1 = z.infer<typeof agentConfigV1Schema>;
export type AgentConfig = AgentConfigV1;
export type GlobalConfigV2 = z.infer<typeof globalConfigV2Schema>;
export type AgentConfigV2 = z.infer<typeof agentConfigV2Schema>;
export type LegacyGlobalConfigV1 = z.infer<typeof legacyGlobalConfigV1Schema>;
export type PolicyConfig = z.infer<typeof policyConfigSchema>;
