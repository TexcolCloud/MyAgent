import { z } from "zod";

import type { JsonValue } from "../../domain/json.js";

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

export const agentIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
export const sessionKeySchema = z.string().regex(/^[A-Za-z0-9._:@/-]{1,200}$/);
export const idempotencyKeySchema = z.string().regex(/^[\x20-\x7E]{8,128}$/);
export const identifierSchema = z.string().min(1).max(200);
export const createRunSchema = z.strictObject({
  agentId: agentIdSchema,
  sessionKey: sessionKeySchema,
  input: z.strictObject({ type: z.literal("text"), text: z.string() }),
  source: z.strictObject({ kind: z.literal("http"), externalId: z.string().optional() }).optional(),
});
export const decisionSchema = z.strictObject({ decision: z.enum(["approve", "deny"]) });
export const reconciliationSchema = z.strictObject({
  outcome: z.enum(["succeeded", "failed", "retry"]),
  note: z.string().optional(),
  result: jsonValueSchema.optional(),
});
export const backupRequestSchema = z.strictObject({ destination: z.string().min(1) });

const runStateSchema = z.enum([
  "queued", "running", "waiting_approval", "waiting_reconciliation",
  "completed", "failed", "cancelled",
]);
const activeRunStateSchema = z.enum([
  "queued", "running", "waiting_approval", "cancelling",
]);
export const activeRunsQuerySchema = z.strictObject({ state: z.literal("active") });
export const activeRunsResponseSchema = z.strictObject({
  runs: z.array(z.strictObject({
    runId: z.string(),
    status: activeRunStateSchema,
  })),
});
const runBudgetSchema = z.strictObject({
  modelTurns: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  childRuns: z.number().int().nonnegative(),
  delegationDepth: z.number().int().nonnegative(),
  activeExecutionSeconds: z.number().nonnegative(),
  toolOutputBytes: z.number().int().nonnegative(),
});
export const healthResponseSchema = z.strictObject({ ok: z.literal(true) });
export const readinessResponseSchema = z.strictObject({ ready: z.boolean() });
const unavailableAgentResponseSchema = z.strictObject({
  label: z.string(),
  code: z.literal("invalid_agent_config"),
});
export const agentsResponseSchema = z.strictObject({
  agents: z.array(z.strictObject({ id: agentIdSchema, revisionId: z.string(), displayName: z.string() })),
  unavailable: z.array(unavailableAgentResponseSchema),
});
export const configReloadResponseSchema = z.strictObject({
  agents: z.array(z.strictObject({ id: agentIdSchema, revisionId: z.string() })),
  unavailable: z.array(unavailableAgentResponseSchema),
});
export const createRunResponseSchema = z.strictObject({
  runId: z.string(),
  status: z.literal("queued"),
  eventsUrl: z.string(),
});
export const runResponseSchema = z.strictObject({
  runId: z.string(),
  sessionId: z.string(),
  agentId: agentIdSchema,
  status: runStateSchema,
  fifoSequence: z.number().int().nonnegative(),
  parentRunId: z.string().nullable(),
  rootRunId: z.string(),
  delegationDepth: z.number().int().nonnegative(),
  budget: runBudgetSchema,
  result: jsonValueSchema.optional(),
  failure: z.strictObject({ code: z.string() }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const approvalsResponseSchema = z.strictObject({
  approvals: z.array(z.strictObject({
    approvalId: z.string(),
    runId: z.string(),
    toolCallId: z.string(),
    state: z.literal("pending"),
    toolName: z.string(),
    arguments: jsonValueSchema,
    expiresAt: z.string(),
    riskNotice: z.string().optional(),
  })),
});
export const approvalDecisionResponseSchema = z.strictObject({
  approvalId: z.string(),
  runId: z.string(),
  state: z.enum(["approved", "denied"]),
  resolvedAt: z.string().nullable(),
});
export const reconciliationResponseSchema = z.strictObject({
  toolCallId: z.string(),
  state: z.enum(["succeeded", "failed", "unknown"]),
  retryToolCallId: z.string().optional(),
});
export const sessionsResponseSchema = z.strictObject({
  sessions: z.array(z.strictObject({
    sessionId: z.string(),
    agentId: agentIdSchema,
    sessionKey: sessionKeySchema,
    createdAt: z.string(),
    updatedAt: z.string(),
  })),
});
export const backupResponseSchema = z.strictObject({
  destination: z.string(),
  database: z.literal("kernel.db"),
  fileCount: z.number().int().positive(),
  activeRevisionIds: z.array(z.string()),
});

export type ActiveRunsResponse = z.infer<typeof activeRunsResponseSchema>;
export type AgentsResponse = z.infer<typeof agentsResponseSchema>;
export type CreateRunResponse = z.infer<typeof createRunResponseSchema>;
export type RunResponse = z.infer<typeof runResponseSchema>;
export type ApprovalsResponse = z.infer<typeof approvalsResponseSchema>;
export type ApprovalDecisionResponse = z.infer<typeof approvalDecisionResponseSchema>;

export function parseSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("invalid_request");
  return result.data;
}

export function serializeWithSchema(schema: unknown): (value: unknown) => string {
  return (value) => {
    const result = (schema as z.ZodType<unknown>).safeParse(value);
    if (!result.success) throw new Error("invalid_response");
    return JSON.stringify(result.data);
  };
}
