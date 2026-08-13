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
export const cancelRunSchema = z.strictObject({ confirm: z.literal(true), expectedRevision: z.string().datetime() });
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
const diagnosticCheck = <Id extends string, Ok extends string, Failed extends string>(id: Id, ok: Ok, failed: Failed) =>
  z.union([
    z.strictObject({ id: z.literal(id), status: z.literal("ok"), detail: z.literal(ok) }),
    z.strictObject({ id: z.literal(id), status: z.literal("failed"), detail: z.literal(failed) }),
  ]);
export const diagnosticsResponseSchema = z.strictObject({ checks: z.tuple([
  diagnosticCheck("config", "config_readable", "config_unreadable"),
  diagnosticCheck("permissions", "project_permissions_ok", "project_permissions_unavailable"),
  diagnosticCheck("sqlite", "sqlite_migrations_current", "sqlite_migrations_unavailable"),
  diagnosticCheck("secrets", "secret_references_resolved", "secret_references_unavailable"),
  diagnosticCheck("workers", "worker_ready", "worker_not_ready"),
  diagnosticCheck("gateway", "provider_gateway_available", "provider_gateway_unavailable"),
  diagnosticCheck("tty", "interactive_tty_available", "interactive_tty_unavailable"),
  diagnosticCheck("binding", "loopback_binding", "binding_unavailable"),
]) });
const unavailableAgentResponseSchema = z.strictObject({
  label: z.string(),
  code: z.literal("invalid_agent_config"),
});
export const agentsResponseSchema = z.strictObject({
  catalogRevision: z.string().startsWith("catalog_"),
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
export const runHistoryQuerySchema = z.strictObject({
  agentId: agentIdSchema,
  sessionKey: sessionKeySchema,
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
});
export const runHistoryResponseSchema = z.strictObject({
  items: z.array(runResponseSchema),
  nextCursor: z.string().optional(),
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
export const sessionHistoryQuerySchema = z.strictObject({
  agentId: agentIdSchema.optional(), sessionKey: sessionKeySchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(), cursor: z.string().min(1).optional(),
});
export const sessionHistoryResponseSchema = z.strictObject({
  items: z.array(z.strictObject({ sessionId: z.string(), agentId: agentIdSchema, sessionKey: sessionKeySchema, createdAt: z.string(), updatedAt: z.string() })),
  nextCursor: z.string().optional(),
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
