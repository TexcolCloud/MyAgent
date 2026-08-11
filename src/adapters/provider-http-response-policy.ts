import type { IncomingHttpHeaders } from "node:http";

import type { ProviderRuntimeErrorCode } from "../domain/errors.js";
import { ModelProviderError } from "../ports/model.js";

export const MAX_REDIRECTS = 5;
const MAX_RETRY_AFTER_MS = 30_000;

export class ProviderTimeoutError extends Error {}

export function redirectRequest(request: Request, url: URL, status: number): Request {
  const becomesGet =
    (status === 303 && request.method !== "GET" && request.method !== "HEAD") ||
    ((status === 301 || status === 302) && request.method === "POST");
  if (!becomesGet && request.body !== null) {
    throw protocolError(status);
  }
  const headers = new Headers(request.headers);
  if (becomesGet) {
    headers.delete("content-length");
    headers.delete("content-type");
  }
  return new Request(url, {
    method: becomesGet ? "GET" : request.method,
    headers,
    signal: request.signal,
    redirect: "manual",
  });
}

export function parseRedirectUrl(location: string, current: URL): URL {
  let url: URL;
  try {
    url = new URL(location, current);
  } catch {
    throw providerError("invalid_provider_url", false);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw providerError("invalid_provider_url", false);
  }
  return url;
}

export function errorForStatus(
  status: number,
  headers: IncomingHttpHeaders,
): ModelProviderError | undefined {
  if (status < 400) return undefined;
  const retryAfterMs = parseRetryAfter(firstHeader(headers["retry-after"]));
  if (status === 401 || status === 403) {
    return providerError("provider_auth_failed", false, status);
  }
  if (status === 429) {
    return providerError("provider_rate_limited", true, status, retryAfterMs);
  }
  if (status === 404 || status === 405 || status === 501) {
    return providerError("model_protocol_error", false, status);
  }
  if (status === 408 || status === 425 || status >= 500) {
    return providerError("provider_unavailable", true, status, retryAfterMs);
  }
  return providerError("model_protocol_error", false, status);
}

export function normalizeRequestError(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted || isAbortError(error)) return abortError();
  if (error instanceof ModelProviderError) return error;
  if (error instanceof ProviderTimeoutError) {
    return providerError("provider_unavailable", true);
  }
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
  return code.startsWith("HPE_")
    ? protocolError()
    : providerError("provider_unavailable", true);
}

export function providerError(
  code: ProviderRuntimeErrorCode,
  transient: boolean,
  status?: number,
  retryAfterMs?: number,
): ModelProviderError {
  return new ModelProviderError({
    code,
    transient,
    ...(status === undefined ? {} : { status }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

export function protocolError(status?: number): ModelProviderError {
  return providerError("model_protocol_error", false, status);
}

export function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export function firstHeader(
  value: string | readonly string[] | undefined,
): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

export async function withDeadline<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  deadline: number,
): Promise<T> {
  if (signal.aborted) throw abortError();
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new ProviderTimeoutError();
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => finishReject(new ProviderTimeoutError()), remainingMs);
    const onAbort = (): void => finishReject(abortError());
    const cleanup = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    };
    const finishResolve = (value: T): void => {
      cleanup();
      resolve(value);
    };
    const finishReject = (error: unknown): void => {
      cleanup();
      reject(error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(finishResolve, finishReject);
  });
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1_000
    : Date.parse(value) - Date.now();
  if (!Number.isFinite(delay) || delay < 0) return undefined;
  return Math.min(Math.round(delay), MAX_RETRY_AFTER_MS);
}
