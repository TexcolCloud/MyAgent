declare const identifierBrand: unique symbol;

type Branded<T, Name extends string> = T & {
  readonly [identifierBrand]: Name;
};

export type SessionKey = Branded<string, "SessionKey">;
export type AgentId = Branded<string, "AgentId">;
export type IdempotencyKey = Branded<string, "IdempotencyKey">;
export type SessionId = Branded<string, "SessionId">;
export type RunId = Branded<string, "RunId">;
export type ToolCallId = Branded<string, "ToolCallId">;
export type ApprovalId = Branded<string, "ApprovalId">;
export type AttemptId = Branded<string, "AttemptId">;

function brand<T, Name extends string>(value: T): Branded<T, Name> {
  return value as Branded<T, Name>;
}

const SESSION_KEY_PATTERN = /^[A-Za-z0-9._:@/-]{1,200}$/;
const AGENT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7E]{8,128}$/;

export function parseAgentId(value: string): AgentId {
  if (!AGENT_ID_PATTERN.test(value)) {
    throw new Error("invalid_agent_id");
  }

  return brand<string, "AgentId">(value);
}

export function parseSessionKey(value: string): SessionKey {
  if (!SESSION_KEY_PATTERN.test(value)) {
    throw new Error("invalid_session_key");
  }

  return brand<string, "SessionKey">(value);
}

export function parseIdempotencyKey(value: string): IdempotencyKey {
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new Error("invalid_idempotency_key");
  }

  return brand<string, "IdempotencyKey">(value);
}

export function sessionIdFromUuid(value: string): SessionId {
  return brand<string, "SessionId">(`ses_${value}`);
}

export function runIdFromUuid(value: string): RunId {
  return brand<string, "RunId">(`run_${value}`);
}

export function toolCallIdFromUuid(value: string): ToolCallId {
  return brand<string, "ToolCallId">(`call_${value}`);
}

export function approvalIdFromUuid(value: string): ApprovalId {
  return brand<string, "ApprovalId">(`apr_${value}`);
}

export function attemptIdFromUuid(value: string): AttemptId {
  return brand<string, "AttemptId">(`att_${value}`);
}
