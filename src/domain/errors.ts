import type { JsonValue } from "./json.js";

export const PROVIDER_RUNTIME_ERROR_CODES = [
  "invalid_provider_url",
  "insecure_provider_url",
  "provider_auth_failed",
  "provider_unavailable",
  "provider_rate_limited",
  "model_discovery_unsupported",
  "model_not_found",
  "invocation_protocol_unsupported",
  "streaming_unsupported",
  "tool_call_unsupported",
  "model_protocol_error",
  "secret_locked",
  "verification_required",
  "model_assignment_required",
  "revision_conflict",
  "model_provider_locked",
  "unsupported_endpoint",
] as const;

export type ProviderRuntimeErrorCode =
  (typeof PROVIDER_RUNTIME_ERROR_CODES)[number];

export const REGISTRY_CONTROL_PLANE_ERROR_CODES = [
  "legacy_assignment_forbidden",
  "resource_in_use",
  "connection_revision_not_active",
  "legacy_import_already_completed",
] as const;

export type RegistryControlPlaneErrorCode =
  (typeof REGISTRY_CONTROL_PLANE_ERROR_CODES)[number];

export type RegistryErrorCode =
  | ProviderRuntimeErrorCode
  | RegistryControlPlaneErrorCode;

export class DomainError extends Error {
  readonly details: JsonValue | undefined;

  constructor(code: string, message: string = code, details?: JsonValue) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }

  readonly code: string;
}

export class ApplicationError extends Error {
  readonly details: JsonValue | undefined;

  constructor(
    readonly code: string,
    readonly status: number,
    message: string = code,
    details?: JsonValue,
  ) {
    super(message);
    this.name = "ApplicationError";
    this.details = details;
  }
}
