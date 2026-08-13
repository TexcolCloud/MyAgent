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
] as const;

export type ProviderRuntimeErrorCode =
  (typeof PROVIDER_RUNTIME_ERROR_CODES)[number];

export const VERIFICATION_RESULT_CODES = [
  "provider_auth_failed",
  "provider_unavailable",
  "provider_rate_limited",
  "model_not_found",
  "invocation_protocol_unsupported",
  "streaming_unsupported",
  "tool_call_unsupported",
  "model_protocol_error",
  "secret_locked",
] as const satisfies readonly ProviderRuntimeErrorCode[];

export type VerificationResultCode =
  (typeof VERIFICATION_RESULT_CODES)[number];

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

export const DOMAIN_ERROR_CODES = [
  "activated_skill_not_in_revision",
  "active_skill_source_missing",
  "approval_checkpoint_missing",
  "approval_not_found",
  "approval_not_pending",
  "approval_run_not_waiting",
  "approval_tool_checkpoint_invalid",
  "connection_revision_not_active",
  "connection_revision_owner_mismatch",
  "context_budget_exceeded",
  "context_budget_not_reduced",
  "delegate_not_allowed",
  "delegate_tool_not_executing",
  "delegation_count_exceeded",
  "delegation_depth_exceeded",
  "duplicate_skill_name",
  "environment_not_allowed",
  "file_changed",
  "invalid_approval_transition",
  "invalid_backup_partial_path",
  "invalid_backup_source_path",
  "invalid_budget_delta",
  "invalid_global_config",
  "invalid_model_context_window",
  "invalid_model_profile",
  "invalid_process_argument",
  "invalid_provider_connection",
  "invalid_run_fifo_sequence",
  "invalid_run_transition",
  "invalid_session_summary",
  "invalid_skill",
  "invalid_tool_arguments",
  "invalid_tool_call_transition",
  "invalid_verification_lease",
  "legacy_assignment_forbidden",
  "manual_model_entry_required",
  "model_assignment_required",
  "model_protocol_error",
  "path_outside_workspace",
  "process_tree_termination_failed",
  "profile_revision_owner_mismatch",
  "provider_health_target_mismatch",
  "reconciliation_retry_checkpoint_missing",
  "reconciliation_retry_result_forbidden",
  "resource_in_use",
  "resource_retired",
  "revision_hash_collision",
  "run_budget_exceeded",
  "run_cancellation_not_requested",
  "run_lease_lost",
  "run_lease_or_budget_invalid",
  "run_not_advanceable",
  "run_not_found",
  "run_not_waiting_reconciliation",
  "run_reconciliation_or_budget_invalid",
  "secret_locked",
  "session_has_running_run",
  "session_not_found",
  "skill_not_available",
  "skill_root_escape",
  "streaming_unsupported",
  "summary_id_collision",
  "synthetic_session_owned",
  "tool_call_not_found",
  "tool_call_not_unknown",
  "tool_call_unsupported",
  "tool_checkpoint_not_implemented",
  "tool_not_allowed",
  "tool_not_executing",
  "tool_not_executing_side_effect",
  "tool_not_found",
  "tool_not_registered",
  "tool_timeout_exceeds_limit",
  "value_not_canonicalizable",
  "verification_lease_lost",
  "verification_profile_revision_mismatch",
  "verification_required",
  "verification_terminal",
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export const APPLICATION_ERROR_CODES = [
  "agent_unavailable",
  "approval_already_resolved",
  "backup_destination_exists",
  "idempotency_conflict",
  "invalid_managed_agent",
  "legacy_import_already_completed",
  "model_assignment_required",
  "model_provider_locked",
  "managed_agent_exists",
  "reconciliation_result_too_large",
  "reconciliation_retry_cancelled_run",
  "reconciliation_retry_result_forbidden",
  "resource_conflict",
  "restart_required",
  "revision_conflict",
  "tool_call_already_reconciled",
  "unmanaged_agent_root",
  "verification_required",
] as const;

export type ApplicationErrorCode = (typeof APPLICATION_ERROR_CODES)[number];

export const CONTROL_PLANE_PROBLEM_CODES = [
  "connection_revision_not_active",
  "connection_revision_owner_mismatch",
  "insecure_provider_url",
  "invalid_model_context_window",
  "invalid_model_profile",
  "invalid_managed_agent",
  "invalid_provider_connection",
  "invalid_provider_url",
  "legacy_assignment_forbidden",
  "legacy_import_already_completed",
  "manual_model_entry_required",
  "managed_agent_exists",
  "model_assignment_required",
  "model_profile_not_found",
  "model_profile_revision_not_found",
  "model_provider_locked",
  "model_verification_not_found",
  "profile_revision_owner_mismatch",
  "provider_connection_not_found",
  "provider_connection_revision_not_found",
  "resource_conflict",
  "resource_in_use",
  "resource_retired",
  "revision_conflict",
  "secret_locked",
  "verification_required",
  "verification_terminal",
  "unmanaged_agent_root",
] as const;

export type ControlPlaneProblemCode =
  (typeof CONTROL_PLANE_PROBLEM_CODES)[number];

export const M1_HTTP_PROBLEM_CODES = [
  "agent_unavailable",
  "approval_already_resolved",
  "approval_not_found",
  "backup_destination_exists",
  "idempotency_conflict",
  "invalid_backup_partial_path",
  "invalid_backup_source_path",
  "reconciliation_result_too_large",
  "reconciliation_retry_cancelled_run",
  "reconciliation_retry_result_forbidden",
  "restart_required",
  "run_not_found",
  "session_has_running_run",
  "session_not_found",
  "synthetic_session_owned",
  "tool_call_already_reconciled",
  "tool_call_not_found",
] as const satisfies readonly (DomainErrorCode | ApplicationErrorCode)[];

export type M1HttpProblemCode = (typeof M1_HTTP_PROBLEM_CODES)[number];

export const PUBLIC_PROBLEM_CODES = [
  ...M1_HTTP_PROBLEM_CODES,
  ...CONTROL_PLANE_PROBLEM_CODES,
] as const;

export type PublicProblemCode = (typeof PUBLIC_PROBLEM_CODES)[number];

export class DomainError extends Error {
  readonly details: JsonValue | undefined;

  constructor(code: DomainErrorCode, message: string = code, details?: JsonValue) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }

  readonly code: DomainErrorCode;
}

export class ApplicationError extends Error {
  readonly details: JsonValue | undefined;

  constructor(
    readonly code: ApplicationErrorCode,
    readonly status: number,
    message: string = code,
    details?: JsonValue,
  ) {
    super(message);
    this.name = "ApplicationError";
    this.details = details;
  }
}
