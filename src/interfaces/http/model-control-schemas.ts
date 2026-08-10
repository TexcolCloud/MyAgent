import { z } from "zod";

import { agentIdSchema, identifierSchema } from "./schemas.js";

export const invocationProtocolSchema = z.enum(["chat_completions", "responses"]);
export const providerKindSchema = z.enum(["openai", "deepseek", "openai_compatible"]);

export const providerAuthInputSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.literal("api_key") }),
  z.strictObject({
    type: z.literal("environment"),
    fromEnvironment: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  }),
  z.strictObject({
    type: z.literal("managed_secret"),
    secretVersionId: identifierSchema,
  }),
]);

export const createProviderConnectionSchema = z.strictObject({
  slug: agentIdSchema,
  displayName: z.string().min(1),
  kind: providerKindSchema,
  baseUrl: z.string().url().optional(),
  auth: providerAuthInputSchema,
  apiKey: z.string().min(1).optional(),
  allowInsecureHttp: z.boolean().optional(),
  protocolPreference: invocationProtocolSchema.optional(),
}).superRefine((value, context) => {
  if ((value.auth.type === "api_key") !== (value.apiKey !== undefined)) {
    context.addIssue({ code: "custom", message: "invalid credential input" });
  }
});

export const reviseProviderConnectionSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  displayName: z.string().min(1),
  baseUrl: z.string().url(),
  auth: providerAuthInputSchema,
  apiKey: z.string().min(1).optional(),
  allowInsecureHttp: z.boolean(),
  protocolPreference: invocationProtocolSchema,
}).superRefine((value, context) => {
  if ((value.auth.type === "api_key") !== (value.apiKey !== undefined)) {
    context.addIssue({ code: "custom", message: "invalid credential input" });
  }
});

const providerConnectionRevisionResponseSchema = z.strictObject({
  revisionId: identifierSchema,
  connectionId: agentIdSchema,
  state: z.enum([
    "draft", "verifying", "failed", "verified", "active", "superseded",
    "retired", "legacy_trusted",
  ]),
  baseUrl: z.string(),
  allowInsecureHttp: z.boolean(),
  protocolPreference: invocationProtocolSchema,
  presetVersion: z.string(),
  credentialConfigured: z.boolean(),
  secretVersionId: identifierSchema.optional(),
  createdAt: z.string(),
});

export const providerConnectionResponseSchema = z.strictObject({
  connectionId: agentIdSchema,
  displayName: z.string(),
  providerKind: providerKindSchema,
  activeRevisionId: identifierSchema.nullable(),
  retiredAt: z.string().nullable(),
  recordRevision: z.number().int().nonnegative(),
  credentialConfigured: z.boolean(),
  secretVersionId: identifierSchema.optional(),
  revisions: z.array(providerConnectionRevisionResponseSchema),
});

export const providerConnectionsResponseSchema = z.strictObject({
  connections: z.array(providerConnectionResponseSchema),
});

export const discoverModelsSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
});

const discoveredModelResponseSchema = z.strictObject({
  id: z.string(),
  owner: z.string().optional(),
  createdAt: z.string().optional(),
});

export const discoveryResponseSchema = z.strictObject({
  connectionRevisionId: identifierSchema,
  recordRevision: z.number().int().nonnegative(),
  state: z.enum(["fresh", "stale", "empty", "unsupported", "failed"]),
  models: z.array(discoveredModelResponseSchema),
  cache: z.strictObject({
    fetchedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
  }),
  error: z.strictObject({
    code: z.string(),
    status: z.number().int().min(400).max(599).optional(),
    traceId: z.string(),
  }).nullable(),
});

export const createModelProfileSchema = z.strictObject({
  slug: agentIdSchema,
  displayName: z.string().min(1),
  connectionRevisionId: identifierSchema,
  modelId: z.string().min(1),
  protocol: z.enum(["auto", "chat_completions", "responses"]),
  maxInputTokens: z.number().int().positive().optional(),
  contextWindowSource: z.enum(["preset", "operator", "assumed_32768"]).optional(),
  manualEntryAcknowledged: z.boolean().optional(),
});

const modelProfileRevisionResponseSchema = z.strictObject({
  revisionId: identifierSchema,
  profileId: agentIdSchema,
  connectionRevisionId: identifierSchema,
  providerModelId: z.string(),
  invocationProtocol: invocationProtocolSchema,
  maxInputTokens: z.number().int().positive(),
  contextWindowSource: z.enum(["preset", "operator", "assumed_32768"]),
  capabilityBaseline: z.literal("text_and_single_tool_call_v1"),
  verifiedCapabilities: z.array(z.enum(["streaming_text", "single_tool_call"])),
  state: z.enum([
    "draft", "verifying", "failed", "verified", "active", "superseded",
    "retired", "legacy_trusted",
  ]),
  createdAt: z.string(),
});

export const modelProfileResponseSchema = z.strictObject({
  profileId: agentIdSchema,
  displayName: z.string(),
  activeRevisionId: identifierSchema.nullable(),
  retiredAt: z.string().nullable(),
  recordRevision: z.number().int().nonnegative(),
  revisions: z.array(modelProfileRevisionResponseSchema),
});

export const modelProfilesResponseSchema = z.strictObject({
  profiles: z.array(modelProfileResponseSchema),
});
