import type { FastifyReply, FastifyRequest } from "fastify";

import { ApplicationError, DomainError } from "../../domain/errors.js";
import { ModelProviderError } from "../../ports/model.js";

interface Problem {
  type: "about:blank";
  title: string;
  status: number;
  code: string;
  detail: string;
  traceId: string;
  ownerCategories?: readonly SafeOwnerCategory[];
}

type SafeOwnerCategory = typeof SAFE_OWNER_CATEGORIES[number];

export function sendProblem(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: string,
  detail: string,
  ownerCategories?: readonly SafeOwnerCategory[],
): FastifyReply {
  const problem: Problem = {
    type: "about:blank",
    title: titleForStatus(status),
    status,
    code,
    detail,
    traceId: request.id,
    ...(ownerCategories === undefined ? {} : { ownerCategories }),
  };
  return reply
    .code(status)
    .type("application/problem+json")
    .send(problem);
}

export function sendError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof ApplicationError) {
    return sendProblem(
      reply,
      request,
      error.status,
      error.code,
      publicDetail(error.code),
      safeOwnerCategories(error),
    );
  }
  if (error instanceof DomainError) {
    return sendProblem(
      reply,
      request,
      domainStatus(error.code),
      error.code,
      publicDetail(error.code),
      safeOwnerCategories(error),
    );
  }
  if (error instanceof ModelProviderError && PROVIDER_INPUT_ERROR_CODES.includes(
    error.code as typeof PROVIDER_INPUT_ERROR_CODES[number],
  )) {
    return sendProblem(reply, request, 422, error.code, publicDetail(error.code));
  }
  if (error instanceof Error && CONTROL_PLANE_NOT_FOUND_CODES.includes(
    error.message as typeof CONTROL_PLANE_NOT_FOUND_CODES[number],
  )) {
    return sendProblem(
      reply,
      request,
      404,
      error.message,
      "The requested resource does not exist.",
    );
  }
  if (error instanceof Error && error.message === "run_not_found") {
    return sendProblem(reply, request, 404, "run_not_found", "The requested Run does not exist.");
  }
  if (error instanceof Error && MALFORMED_REQUEST_CODES.includes(
    error.message as typeof MALFORMED_REQUEST_CODES[number],
  )) {
    return sendProblem(reply, request, 400, "invalid_request", "The request is invalid.");
  }
  if (isMalformedRequest(error)) {
    return sendProblem(reply, request, 400, "invalid_request", "The request is invalid.");
  }
  if (isSqliteUnavailable(error)) {
    return sendProblem(reply, request, 503, "database_unavailable", "The database is temporarily unavailable.");
  }
  request.log.error({ traceId: request.id, code: "internal_error" }, "request failed");
  return sendProblem(reply, request, 500, "internal_error", "The request could not be completed.");
}

const CONTROL_PLANE_NOT_FOUND_CODES = [
  "provider_connection_not_found",
  "provider_connection_revision_not_found",
  "model_profile_not_found",
  "model_profile_revision_not_found",
  "model_verification_not_found",
] as const;

const MALFORMED_REQUEST_CODES = [
  "invalid_request",
  "invalid_last_event_id",
  "invalid_provider_connection_id",
  "invalid_model_profile_id",
] as const;

const PROVIDER_INPUT_ERROR_CODES = [
  "invalid_provider_url",
  "insecure_provider_url",
] as const;

const SAFE_OWNER_CATEGORIES = [
  "default_model_profile",
  "model_assignment",
  "model_profile",
  "provider_connection_revision",
  "retained_run_snapshot",
] as const;

function isSqliteUnavailable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "errcode" in error && (error as { errcode?: unknown }).errcode === 5;
}

function isMalformedRequest(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const httpError = error as Error & { statusCode?: unknown; code?: unknown };
  return httpError.statusCode === 400 || httpError.code === "FST_ERR_CTP_INVALID_JSON_BODY";
}

function domainStatus(code: string): number {
  if (code.endsWith("_not_found")) return 404;
  if (
    code.includes("already_resolved") ||
    code.includes("conflict") ||
    code === "resource_in_use" ||
    code === "session_has_running_run"
  ) return 409;
  return 422;
}

function safeOwnerCategories(
  error: ApplicationError | DomainError,
): readonly SafeOwnerCategory[] | undefined {
  if (error.code !== "resource_in_use") return undefined;
  const details = error.details;
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    return undefined;
  }
  const categories = (details as { ownerCategories?: unknown }).ownerCategories;
  if (!Array.isArray(categories) || categories.length === 0) return undefined;
  const safe = categories.filter((value): value is SafeOwnerCategory =>
    typeof value === "string" && SAFE_OWNER_CATEGORIES.includes(
      value as SafeOwnerCategory,
    ));
  return safe.length === categories.length ? [...new Set(safe)] : undefined;
}

function publicDetail(code: string): string {
  switch (code) {
    case "unauthorized":
      return "Authentication is required.";
    case "run_not_found":
      return "The requested Run does not exist.";
    case "agent_unavailable":
      return "The requested Agent is unavailable.";
    default:
      return "The request could not be completed.";
  }
}

function titleForStatus(status: number): string {
  if (status === 400) return "Bad Request";
  if (status === 401) return "Unauthorized";
  if (status === 403) return "Forbidden";
  if (status === 404) return "Not Found";
  if (status === 409) return "Conflict";
  if (status === 422) return "Unprocessable Content";
  if (status === 503) return "Service Unavailable";
  return "Internal Server Error";
}
