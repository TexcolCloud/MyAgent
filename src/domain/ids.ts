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
export type ProviderConnectionId = Branded<string, "ProviderConnectionId">;
export type ModelProfileId = Branded<string, "ModelProfileId">;
export type ProviderConnectionRevisionId = Branded<string, "ProviderConnectionRevisionId">;
export type ModelProfileRevisionId = Branded<string, "ModelProfileRevisionId">;
export type ModelVerificationId = Branded<string, "ModelVerificationId">;
export type ManagedSecretVersionId = Branded<string, "ManagedSecretVersionId">;
export type ModelRegistryEventId = Branded<string, "ModelRegistryEventId">;
export type DiscoveryGenerationId = Branded<string, "DiscoveryGenerationId">;

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

export function parseProviderConnectionId(value: string): ProviderConnectionId {
  if (!AGENT_ID_PATTERN.test(value)) {
    throw new Error("invalid_provider_connection_id");
  }

  return brand<string, "ProviderConnectionId">(value);
}

export function parseModelProfileId(value: string): ModelProfileId {
  if (!AGENT_ID_PATTERN.test(value)) {
    throw new Error("invalid_model_profile_id");
  }

  return brand<string, "ModelProfileId">(value);
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

export function providerConnectionRevisionIdFromUuid(value: string): ProviderConnectionRevisionId {
  return brand<string, "ProviderConnectionRevisionId">(`pcr_${value}`);
}

export function modelProfileRevisionIdFromUuid(value: string): ModelProfileRevisionId {
  return brand<string, "ModelProfileRevisionId">(`mpr_${value}`);
}

export function modelVerificationIdFromUuid(value: string): ModelVerificationId {
  return brand<string, "ModelVerificationId">(`ver_${value}`);
}

export function managedSecretVersionIdFromUuid(value: string): ManagedSecretVersionId {
  return brand<string, "ManagedSecretVersionId">(`msv_${value}`);
}

export function modelRegistryEventIdFromUuid(value: string): ModelRegistryEventId {
  return brand<string, "ModelRegistryEventId">(`mre_${value}`);
}

export function discoveryGenerationIdFromUuid(value: string): DiscoveryGenerationId {
  return brand<string, "DiscoveryGenerationId">(`dgn_${value}`);
}
