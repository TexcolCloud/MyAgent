import { z } from "zod";

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
  result: z.unknown().optional(),
});

export function parseSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("invalid_request");
  return result.data;
}
