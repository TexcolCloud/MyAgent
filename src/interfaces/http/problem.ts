import type { FastifyReply, FastifyRequest } from "fastify";

import { ApplicationError, DomainError } from "../../domain/errors.js";

interface Problem {
  type: "about:blank";
  title: string;
  status: number;
  code: string;
  detail: string;
  traceId: string;
}

export function sendProblem(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: string,
  detail: string,
): FastifyReply {
  const problem: Problem = {
    type: "about:blank",
    title: titleForStatus(status),
    status,
    code,
    detail,
    traceId: request.id,
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
    return sendProblem(reply, request, error.status, error.code, publicDetail(error.code));
  }
  if (error instanceof DomainError) {
    return sendProblem(reply, request, domainStatus(error.code), error.code, publicDetail(error.code));
  }
  if (error instanceof Error && error.message === "run_not_found") {
    return sendProblem(reply, request, 404, "run_not_found", "The requested Run does not exist.");
  }
  if (error instanceof Error && (error.message === "invalid_request" || error.message === "invalid_last_event_id")) {
    return sendProblem(reply, request, 400, "invalid_request", "The request is invalid.");
  }
  if (isSqliteUnavailable(error)) {
    return sendProblem(reply, request, 503, "database_unavailable", "The database is temporarily unavailable.");
  }
  request.log.error({ traceId: request.id, code: "internal_error" }, "request failed");
  return sendProblem(reply, request, 500, "internal_error", "The request could not be completed.");
}

function isSqliteUnavailable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "errcode" in error && (error as { errcode?: unknown }).errcode === 5;
}

function domainStatus(code: string): number {
  if (code.endsWith("_not_found")) return 404;
  if (code.includes("already_resolved") || code.includes("conflict")) return 409;
  return 422;
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
  if (status === 404) return "Not Found";
  if (status === 409) return "Conflict";
  if (status === 422) return "Unprocessable Content";
  if (status === 503) return "Service Unavailable";
  return "Internal Server Error";
}
