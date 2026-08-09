import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";

import type { ProviderRuntimeErrorCode } from "../domain/errors.js";
import type { ProviderConnectionRevision } from "../domain/provider-connection.js";
import { ModelProviderError } from "../ports/model.js";
import type {
  ProviderHttpTransport,
  ProviderHttpTransportInput,
} from "../ports/provider-http-transport.js";
import type { SecretResolver } from "../ports/secret-resolver.js";

const MAX_REDIRECTS = 5;
const MAX_RETRY_AFTER_MS = 30_000;
const AWS_METADATA_IPV6 = [
  0xfd, 0x00, 0x0e, 0xc2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x02, 0x54,
] as const;

export type ProviderAddressClass =
  | "loopback"
  | "private"
  | "link_local"
  | "metadata"
  | "multicast"
  | "unspecified"
  | "public"
  | "invalid";

export interface ResolvedProviderAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type ProviderAddressResolver = (
  hostname: string,
) => Promise<readonly ResolvedProviderAddress[]>;

export interface NodeProviderHttpTransportOptions {
  readonly secretResolver: SecretResolver;
  readonly resolveAddresses?: ProviderAddressResolver;
  readonly connectTimeoutMs?: number;
  readonly tlsCa?: string | Buffer | (string | Buffer)[];
}

interface RequestContext {
  readonly baseOrigin: string;
  readonly connection: ProviderConnectionRevision;
  readonly deadline: number;
  readonly maxResponseBytes: number;
  bearerToken?: string;
}

interface RawResponse {
  readonly message: IncomingMessage;
  readonly url: URL;
}

class ProviderTimeoutError extends Error {}

export class NodeProviderHttpTransport implements ProviderHttpTransport {
  private readonly resolveAddresses: ProviderAddressResolver;

  constructor(private readonly options: NodeProviderHttpTransportOptions) {
    this.resolveAddresses = options.resolveAddresses ?? resolveWithNode;
  }

  createFetch(input: ProviderHttpTransportInput): typeof fetch {
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
      throw protocolError();
    }
    if (
      !Number.isSafeInteger(input.maxResponseBytes) ||
      input.maxResponseBytes < 0
    ) {
      throw protocolError();
    }

    const normalizedBaseUrl = normalizeProviderBaseUrl(input.connection.baseUrl);
    const baseUrl = parseProviderUrl(normalizedBaseUrl);
    validateLiteralAddress(baseUrl, input.connection.allowInsecureHttp);

    const providerFetch = async (
      requestInfo: string | URL | Request,
      requestInit?: RequestInit,
    ): Promise<Response> => {
      let request: Request;
      try {
        request = new Request(requestInfo, requestInit);
      } catch {
        throw providerError("invalid_provider_url", false);
      }
      if (request.signal.aborted) throw abortError();

      const context: RequestContext = {
        baseOrigin: baseUrl.origin,
        connection: input.connection,
        deadline: Date.now() + input.timeoutMs,
        maxResponseBytes: input.maxResponseBytes,
      };
      return this.execute(request, context, 0);
    };

    return providerFetch as typeof fetch;
  }

  private async execute(
    request: Request,
    context: RequestContext,
    redirectCount: number,
  ): Promise<Response> {
    const url = validateRequestUrl(request.url, context.baseOrigin);
    const selectedAddress = await this.resolveAndValidate(
      url,
      context.connection.allowInsecureHttp,
      request.signal,
      context.deadline,
    );
    if (request.signal.aborted) throw abortError();
    context.bearerToken ??= this.resolveBearerToken(context.connection);

    const raw = await this.send(request, url, selectedAddress, context);
    const status = raw.message.statusCode;
    if (status === undefined) {
      raw.message.destroy();
      throw protocolError();
    }

    if (isRedirectStatus(status)) {
      const location = firstHeader(raw.message.headers.location);
      raw.message.destroy();
      if (location === undefined || redirectCount >= MAX_REDIRECTS) {
        throw protocolError(status);
      }

      const redirectUrl = parseRedirectUrl(location, raw.url);
      if (redirectUrl.origin !== context.baseOrigin) {
        throw providerError("invalid_provider_url", false);
      }
      const redirected = redirectRequest(request, redirectUrl, status);
      return this.execute(redirected, context, redirectCount + 1);
    }

    const statusError = errorForStatus(status, raw.message.headers);
    if (statusError !== undefined) {
      raw.message.destroy();
      throw statusError;
    }

    return responseFromIncoming(
      raw.message,
      request.method,
      context.maxResponseBytes,
      context.deadline,
      request.signal,
    );
  }

  private async resolveAndValidate(
    url: URL,
    allowInsecureHttp: boolean,
    signal: AbortSignal,
    deadline: number,
  ): Promise<ResolvedProviderAddress> {
    const hostname = unbracket(url.hostname);
    const literalFamily = isIP(hostname);
    const addresses = literalFamily === 0
      ? await withDeadline(
          this.resolveAddresses(hostname),
          signal,
          deadline,
        ).catch((error: unknown) => {
          if (isAbortError(error)) throw error;
          if (error instanceof ProviderTimeoutError) {
            throw providerError("provider_unavailable", true);
          }
          throw providerError("provider_unavailable", true);
        })
      : [{ address: hostname, family: literalFamily as 4 | 6 }];

    if (addresses.length === 0) {
      throw providerError("provider_unavailable", true);
    }
    for (const address of addresses) {
      const actualFamily = isIP(address.address);
      if (actualFamily === 0 || actualFamily !== address.family) {
        throw providerError("invalid_provider_url", false);
      }
      const classification = classifyProviderAddress(address.address);
      if (!isProviderAddressAllowed(url.protocol, classification, allowInsecureHttp)) {
        throw providerError("insecure_provider_url", false);
      }
    }

    const selected = addresses[0];
    if (selected === undefined) {
      throw providerError("provider_unavailable", true);
    }
    return selected;
  }

  private resolveBearerToken(connection: ProviderConnectionRevision): string {
    if (connection.auth.type === "none") return "";
    try {
      const token = this.options.secretResolver.resolve(connection.auth.secret);
      if (!/^[\x21-\x7e]+$/u.test(token)) throw new Error();
      return token;
    } catch {
      throw providerError("secret_locked", false);
    }
  }

  private async send(
    request: Request,
    url: URL,
    selectedAddress: ResolvedProviderAddress,
    context: RequestContext,
  ): Promise<RawResponse> {
    if (request.signal.aborted) throw abortError();
    const remainingMs = context.deadline - Date.now();
    if (remainingMs <= 0) {
      throw providerError("provider_unavailable", true);
    }

    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.delete("host");
    if (context.connection.auth.type === "bearer") {
      headers.set("authorization", `Bearer ${context.bearerToken ?? ""}`);
    }

    const hostname = unbracket(url.hostname);
    const pinnedLookup = createPinnedLookup(selectedAddress);
    return new Promise<RawResponse>((resolve, reject) => {
      let settled = false;
      const finishReject = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(normalizeRequestError(error, request.signal));
      };
      const finishResolve = (message: IncomingMessage): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ message, url });
      };
      const onAbort = (): void => {
        clientRequest.destroy(abortError());
      };
      const requestTimeout = setTimeout(
        () => clientRequest.destroy(new ProviderTimeoutError()),
        remainingMs,
      );
      let connectTimeout: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        clearTimeout(requestTimeout);
        if (connectTimeout !== undefined) clearTimeout(connectTimeout);
        request.signal.removeEventListener("abort", onAbort);
      };

      const requestOptions: HttpsRequestOptions = {
        protocol: url.protocol,
        hostname,
        ...(url.port.length === 0 ? {} : { port: Number(url.port) }),
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers: Object.fromEntries(headers.entries()),
        agent: false,
        lookup: pinnedLookup,
        ...(url.protocol === "https:"
          ? {
              rejectUnauthorized: true,
              ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
              ...(this.options.tlsCa === undefined ? {} : { ca: this.options.tlsCa }),
            }
          : {}),
      };
      const clientRequest = url.protocol === "https:"
        ? httpsRequest(requestOptions, finishResolve)
        : httpRequest(requestOptions, finishResolve);

      clientRequest.once("error", finishReject);
      request.signal.addEventListener("abort", onAbort, { once: true });
      clientRequest.once("socket", (socket) => {
        if (!socket.connecting) return;
        const connectLimit = Math.min(
          this.options.connectTimeoutMs ?? remainingMs,
          remainingMs,
        );
        const connectedEvent = url.protocol === "https:" ? "secureConnect" : "connect";
        connectTimeout = setTimeout(
          () => clientRequest.destroy(new ProviderTimeoutError()),
          connectLimit,
        );
        socket.once(connectedEvent, () => {
          if (connectTimeout !== undefined) clearTimeout(connectTimeout);
        });
      });

      if (request.body === null) {
        clientRequest.end();
        return;
      }
      void writeRequestBody(request.body, clientRequest).catch(finishReject);
    });
  }
}

export function normalizeProviderBaseUrl(value: string): string {
  const url = parseProviderUrl(value);
  const pathname = url.pathname.replace(/\/+$/u, "");
  return `${url.origin}${pathname}`;
}

export function classifyProviderAddress(address: string): ProviderAddressClass {
  if (isIP(address) === 4) return classifyIpv4(address);
  if (isIP(address) !== 6) return "invalid";

  const bytes = ipv6Bytes(address);
  if (bytes === undefined) return "invalid";
  if (
    bytes.slice(0, 10).every((value) => value === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  ) {
    return classifyIpv4(bytes.slice(12).join("."));
  }
  if (bytes.every((value, index) => value === AWS_METADATA_IPV6[index])) {
    return "metadata";
  }
  if (bytes.every((value) => value === 0)) return "unspecified";
  if (
    bytes.slice(0, 15).every((value) => value === 0) &&
    bytes[15] === 1
  ) {
    return "loopback";
  }
  if ((bytes[0] ?? 0) === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) {
    return "link_local";
  }
  if ((bytes[0] ?? 0) === 0xff) return "multicast";
  if (((bytes[0] ?? 0) & 0xfe) === 0xfc) return "private";
  return "public";
}

export function isProviderAddressAllowed(
  protocol: string,
  classification: ProviderAddressClass,
  allowInsecureHttp: boolean,
): boolean {
  if (
    classification === "invalid" ||
    classification === "link_local" ||
    classification === "metadata" ||
    classification === "multicast" ||
    classification === "unspecified"
  ) {
    return false;
  }
  if (protocol === "https:") return true;
  if (protocol !== "http:") return false;
  if (classification === "loopback") return true;
  return classification === "private" && allowInsecureHttp;
}

function parseProviderUrl(value: string): URL {
  if (value.trim() !== value) {
    throw providerError("invalid_provider_url", false);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw providerError("invalid_provider_url", false);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw providerError("invalid_provider_url", false);
  }
  return url;
}

function validateRequestUrl(value: string, baseOrigin: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw providerError("invalid_provider_url", false);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    url.origin !== baseOrigin
  ) {
    throw providerError("invalid_provider_url", false);
  }
  return url;
}

function validateLiteralAddress(url: URL, allowInsecureHttp: boolean): void {
  const hostname = unbracket(url.hostname);
  if (isIP(hostname) === 0) return;
  if (!isProviderAddressAllowed(url.protocol, classifyProviderAddress(hostname), allowInsecureHttp)) {
    throw providerError("insecure_provider_url", false);
  }
}

async function resolveWithNode(hostname: string): Promise<readonly ResolvedProviderAddress[]> {
  const results: LookupAddress[] = await lookup(hostname, {
    all: true,
    verbatim: true,
  });
  return results.flatMap((result) =>
    result.family === 4 || result.family === 6
      ? [{ address: result.address, family: result.family }]
      : [],
  );
}

function createPinnedLookup(selected: ResolvedProviderAddress): LookupFunction {
  return (_hostname, options, callback): void => {
    if (typeof options === "object" && options.all === true) {
      const allCallback = callback as (
        error: NodeJS.ErrnoException | null,
        addresses: LookupAddress[],
      ) => void;
      allCallback(null, [{ address: selected.address, family: selected.family }]);
      return;
    }
    const oneCallback = callback as (
      error: NodeJS.ErrnoException | null,
      address: string,
      family: number,
    ) => void;
    oneCallback(null, selected.address, selected.family);
  };
}

async function writeRequestBody(
  body: ReadableStream<Uint8Array>,
  request: ReturnType<typeof httpRequest>,
): Promise<void> {
  const reader = body.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!request.write(result.value)) {
        await new Promise<void>((resolve, reject) => {
          request.once("drain", resolve);
          request.once("error", reject);
        });
      }
    }
    request.end();
  } catch (error) {
    request.destroy();
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function responseFromIncoming(
  message: IncomingMessage,
  requestMethod: string,
  maxResponseBytes: number,
  deadline: number,
  signal: AbortSignal,
): Response {
  const status = message.statusCode;
  if (status === undefined) {
    message.destroy();
    throw protocolError();
  }
  const declaredLength = Number(firstHeader(message.headers["content-length"]));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    message.destroy();
    throw protocolError(status);
  }

  const hasNoBody = requestMethod === "HEAD" || status === 204 || status === 205 || status === 304;
  const body = hasNoBody
    ? null
    : incomingBody(message, maxResponseBytes, deadline, signal);
  if (hasNoBody) message.resume();
  return new Response(body, {
    status,
    statusText: "",
    headers: responseHeaders(message.headers),
  });
}

function incomingBody(
  message: IncomingMessage,
  maxResponseBytes: number,
  deadline: number,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let received = 0;
      let closed = false;
      const remainingMs = deadline - Date.now();
      const finish = (action: () => void): void => {
        if (closed) return;
        closed = true;
        cleanup();
        action();
      };
      const onData = (chunk: Buffer): void => {
        received += chunk.byteLength;
        if (received > maxResponseBytes) {
          finish(() => controller.error(protocolError(message.statusCode)));
          message.destroy();
          return;
        }
        controller.enqueue(new Uint8Array(chunk));
      };
      const onEnd = (): void => finish(() => controller.close());
      const onError = (): void =>
        finish(() => controller.error(protocolError(message.statusCode)));
      const onAborted = (): void =>
        finish(() => controller.error(protocolError(message.statusCode)));
      const onSignalAbort = (): void => {
        finish(() => controller.error(abortError()));
        message.destroy();
      };
      const timeout = setTimeout(() => {
        finish(() => controller.error(providerError("provider_unavailable", true)));
        message.destroy();
      }, Math.max(0, remainingMs));
      const cleanup = (): void => {
        clearTimeout(timeout);
        message.off("data", onData);
        message.off("end", onEnd);
        message.off("error", onError);
        message.off("aborted", onAborted);
        signal.removeEventListener("abort", onSignalAbort);
      };

      if (signal.aborted) {
        onSignalAbort();
        return;
      }
      message.on("data", onData);
      message.once("end", onEnd);
      message.once("error", onError);
      message.once("aborted", onAborted);
      signal.addEventListener("abort", onSignalAbort, { once: true });
    },
    cancel() {
      message.destroy();
    },
  });
}

function responseHeaders(headers: IncomingHttpHeaders): Headers {
  const response = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) response.append(name, item);
    } else {
      response.append(name, value);
    }
  }
  return response;
}

function redirectRequest(request: Request, url: URL, status: number): Request {
  const becomesGet =
    status === 303 ||
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

function parseRedirectUrl(location: string, current: URL): URL {
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

function errorForStatus(
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

function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1_000
    : Date.parse(value) - Date.now();
  if (!Number.isFinite(delay) || delay < 0) return undefined;
  return Math.min(Math.round(delay), MAX_RETRY_AFTER_MS);
}

function normalizeRequestError(error: unknown, signal: AbortSignal): Error {
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

function providerError(
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

function protocolError(status?: number): ModelProviderError {
  return providerError("model_protocol_error", false, status);
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

async function withDeadline<T>(
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

function classifyIpv4(address: string): ProviderAddressClass {
  const parts = address.split(".").map(Number);
  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;
  if (first === 0) return "unspecified";
  if (first === 127) return "loopback";
  if (first === 10) return "private";
  if (first === 172 && second >= 16 && second <= 31) return "private";
  if (first === 192 && second === 168) return "private";
  if (first === 169 && second === 254) return "link_local";
  if (first >= 224 && first <= 239) return "multicast";
  return "public";
}

function ipv6Bytes(address: string): number[] | undefined {
  const withoutZone = address.split("%", 1)[0];
  if (withoutZone === undefined) return undefined;
  let normalized = withoutZone;
  const ipv4Match = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized);
  if (ipv4Match?.[1] !== undefined) {
    const octets = ipv4Match[1].split(".").map(Number);
    if (octets.length !== 4) return undefined;
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    normalized = normalized.slice(0, -ipv4Match[1].length) + `${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0]?.length === 0 ? [] : halves[0]?.split(":") ?? [];
  const right = halves.length === 1 || halves[1]?.length === 0 ? [] : halves[1]?.split(":") ?? [];
  const omitted = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (omitted < 0 || (halves.length === 1 && left.length !== 8)) return undefined;
  const segments = [
    ...left,
    ...Array.from({ length: omitted }, () => "0"),
    ...right,
  ].map((segment) => Number.parseInt(segment, 16));
  if (segments.length !== 8 || segments.some((segment) => !Number.isFinite(segment))) {
    return undefined;
  }
  return segments.flatMap((segment) => [segment >> 8, segment & 0xff]);
}

function unbracket(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}
