import type { RunId, SessionId } from "../../domain/ids.js";
import { z } from "zod";

const MAX_CURSOR_LENGTH = 512;
const runIdSchema = z.string().regex(/^run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
const sessionIdSchema = z.string().regex(/^ses_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);

export function encodeRunHistoryCursor(cursor: { readonly updatedAt: Date; readonly runId: RunId }): string {
  return encode({ updatedAt: cursor.updatedAt.toISOString(), runId: cursor.runId });
}

export function decodeRunHistoryCursor(cursor: string): { readonly updatedAt: Date; readonly runId: RunId } {
  const value = decode(cursor, ["updatedAt", "runId"]);
  return { updatedAt: timestamp(value.updatedAt), runId: identifier(value.runId, runIdSchema) as RunId };
}

export function encodeSessionHistoryCursor(cursor: { readonly updatedAt: Date; readonly sessionId: SessionId }): string {
  return encode({ updatedAt: cursor.updatedAt.toISOString(), sessionId: cursor.sessionId });
}

export function decodeSessionHistoryCursor(cursor: string): { readonly updatedAt: Date; readonly sessionId: SessionId } {
  const value = decode(cursor, ["updatedAt", "sessionId"]);
  return { updatedAt: timestamp(value.updatedAt), sessionId: identifier(value.sessionId, sessionIdSchema) as SessionId };
}

function encode(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decode(cursor: string, keys: readonly string[]): Record<string, unknown> {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(cursor)) invalid();
  let value: unknown;
  try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { invalid(); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))) invalid();
  if (!keys.every((key) => typeof record[key] === "string")) invalid();
  const canonical = encode(Object.fromEntries(keys.map((key) => [key, record[key] as string])));
  if (canonical !== cursor) invalid();
  return record;
}

function timestamp(value: unknown): Date {
  if (typeof value !== "string") invalid();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) invalid();
  return parsed;
}

function identifier(value: unknown, schema: z.ZodType<string>): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) invalid();
  return parsed.data;
}

function invalid(): never { throw new Error("invalid_request"); }
