import { randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { EffectiveModelRuntime } from "../domain/agent-revision.js";
import { ModelProviderError } from "../ports/model.js";
import type { ProviderHttpTransport } from "../ports/provider-http-transport.js";
import { providerRuntimeConnection } from "./model/provider-runtime-connection.js";

export interface PiGatewayRoute {
  readonly baseUrl: string;
  readonly apiKey: string;
}

export type ProviderEgressGatewayListen = (
  server: Server,
  address: { readonly host: "127.0.0.1"; readonly port: 0 },
) => Promise<void>;

export interface ProviderEgressGatewayOptions {
  readonly transport: ProviderHttpTransport;
  readonly randomBytes?: (size: number) => Buffer;
  readonly listen?: ProviderEgressGatewayListen;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly onStopped?: () => void | Promise<void>;
}

const LISTEN_ADDRESS = Object.freeze({ host: "127.0.0.1" as const, port: 0 as const });
const CAPABILITY_BYTES = 32;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 16 * 1_024 * 1_024;
const SAFE_REQUEST_HEADERS = new Set([
  "accept",
  "anthropic-beta",
  "anthropic-version",
  "content-type",
  "user-agent",
]);
const SAFE_RESPONSE_HEADERS = new Set(["content-type", "retry-after"]);

type GatewayState = "new" | "starting" | "ready" | "unavailable" | "stopping" | "stopped";

export class ProviderEgressGateway {
  private readonly capabilities = new Map<string, EffectiveModelRuntime>();
  private readonly activeRequests = new Set<AbortController>();
  private server: Server | undefined;
  private listenerBaseUrl: string | undefined;
  private state: GatewayState = "new";
  private startOperation: Promise<this> | undefined;
  private stopOperation: Promise<void> | undefined;

  constructor(private readonly options: ProviderEgressGatewayOptions) {}

  get baseUrl(): string {
    if (this.state !== "ready" || this.listenerBaseUrl === undefined) {
      throw new Error("provider_gateway_not_started");
    }
    return this.listenerBaseUrl;
  }

  get isAvailable(): boolean {
    return this.state === "ready";
  }

  start(): Promise<this> {
    if (this.state === "ready") return Promise.resolve(this);
    if (this.startOperation !== undefined) return this.startOperation;
    if (this.state !== "new") return Promise.reject(this.unavailableError());

    this.state = "starting";
    const operation = this.startServer();
    this.startOperation = operation;
    void operation.then(
      () => { if (this.startOperation === operation) this.startOperation = undefined; },
      () => { if (this.startOperation === operation) this.startOperation = undefined; },
    );
    return operation;
  }

  private async startServer(): Promise<this> {
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    try {
      await (this.options.listen ?? listenOnLoopback)(server, LISTEN_ADDRESS);
      if (this.state !== "starting") throw new Error("provider_gateway_start_cancelled");
      const address = server.address();
      if (
        address === null || typeof address === "string" ||
        address.address !== LISTEN_ADDRESS.host || address.family !== "IPv4"
      ) {
        throw new Error("provider_gateway_non_loopback_binding");
      }
      this.server = server;
      this.listenerBaseUrl = `http://${LISTEN_ADDRESS.host}:${String(address.port)}`;
      this.state = "ready";
      return this;
    } catch (error) {
      await closeServer(server);
      if (this.server === server) this.server = undefined;
      if (this.state === "starting") this.state = "unavailable";
      throw error;
    }
  }

  routeFor(model: EffectiveModelRuntime): PiGatewayRoute {
    if (this.state !== "ready") throw this.unavailableError();
    const baseUrl = this.baseUrl;
    const createBytes = this.options.randomBytes ?? nodeRandomBytes;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const bytes = createBytes(CAPABILITY_BYTES);
      if (bytes.byteLength !== CAPABILITY_BYTES) {
        throw new Error("provider_gateway_invalid_capability_source");
      }
      const capability = bytes.toString("base64url");
      if (this.capabilities.has(capability)) continue;
      this.capabilities.set(capability, freezeRuntime(model));
      return {
        baseUrl: `${baseUrl}/pi/${capability}`,
        apiKey: capability,
      };
    }
    throw new Error("provider_gateway_capability_collision");
  }

  stop(): Promise<void> {
    if (this.stopOperation !== undefined) return this.stopOperation;
    if (this.state === "stopped") return Promise.resolve();

    const operation = this.stopServer();
    this.stopOperation = operation;
    return operation;
  }

  private async stopServer(): Promise<void> {
    const startOperation = this.startOperation;
    this.state = "stopping";
    this.listenerBaseUrl = undefined;
    await startOperation?.then(
      () => undefined,
      () => undefined,
    );
    this.capabilities.clear();
    for (const controller of this.activeRequests) controller.abort();
    this.activeRequests.clear();
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) await closeServer(server);
    this.state = "stopped";
    await this.options.onStopped?.();
  }

  private async handle(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeRequests.add(controller);
    const onAborted = (): void => controller.abort();
    const onClosed = (): void => {
      if (!outgoing.writableEnded) controller.abort();
    };
    incoming.once("aborted", onAborted);
    outgoing.once("close", onClosed);
    try {
      if (incoming.method !== "GET" && incoming.method !== "POST") {
        sendEmpty(outgoing, 405);
        return;
      }
      const parsed = parseGatewayRequest(incoming.url);
      if (parsed === undefined) {
        sendEmpty(outgoing, 401);
        return;
      }
      const runtime = this.authorize(parsed.capability, incoming);
      if (runtime === undefined) {
        sendEmpty(outgoing, 401);
        return;
      }
      const providerUrl = providerRequestUrl(runtime.baseUrl, parsed.suffix);
      if (providerUrl === undefined) {
        sendEmpty(outgoing, 400);
        return;
      }
      const providerFetch = this.options.transport.createFetch({
        connection: providerRuntimeConnection(runtime),
        timeoutMs: this.options.timeoutMs ?? REQUEST_TIMEOUT_MS,
        maxResponseBytes: this.options.maxResponseBytes ?? MAX_RESPONSE_BYTES,
      });
      const headers = safeRequestHeaders(incoming);
      const hasBody = incoming.method === "POST";
      const providerResponse = await providerFetch(providerUrl, {
        method: incoming.method,
        headers,
        signal: controller.signal,
        ...(hasBody
          ? {
              body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
              duplex: "half",
            }
          : {}),
      } as RequestInit);
      if (controller.signal.aborted) return;
      if (!providerResponse.ok) {
        sendGatewayError(
          outgoing,
          providerResponse.status,
          retryAfterMilliseconds(providerResponse.headers),
        );
        return;
      }
      outgoing.writeHead(
        providerResponse.status,
        Object.fromEntries(
          [...providerResponse.headers.entries()].filter(([name]) =>
            SAFE_RESPONSE_HEADERS.has(name.toLowerCase())
          ),
        ),
      );
      if (providerResponse.body === null) {
        outgoing.end();
        return;
      }
      await pipeline(Readable.fromWeb(providerResponse.body), outgoing);
    } catch (error) {
      if (controller.signal.aborted || outgoing.destroyed) {
        outgoing.destroy();
        return;
      }
      const providerError = providerErrorMetadata(error);
      if (providerError !== undefined) {
        sendGatewayError(outgoing, providerError.status, providerError.retryAfterMs);
        return;
      }
      sendEmpty(outgoing, providerErrorStatus(error));
    } finally {
      incoming.off("aborted", onAborted);
      outgoing.off("close", onClosed);
      this.activeRequests.delete(controller);
    }
  }

  private authorize(
    pathCapability: string,
    request: IncomingMessage,
  ): EffectiveModelRuntime | undefined {
    const bearerCapability = parseBearerCapability(request);
    const pathBytes = fixedCapabilityBytes(pathCapability);
    const bearerBytes = bearerCapability === undefined
      ? undefined
      : fixedCapabilityBytes(bearerCapability);
    if (pathBytes === undefined || bearerBytes === undefined) return undefined;

    let selected: EffectiveModelRuntime | undefined;
    for (const [capability, runtime] of this.capabilities) {
      const expected = Buffer.from(capability, "ascii");
      const pathMatches = timingSafeEqual(expected, pathBytes);
      const bearerMatches = timingSafeEqual(expected, bearerBytes);
      if (pathMatches && bearerMatches) selected = runtime;
    }
    return selected;
  }

  private unavailableError(): ModelProviderError {
    return new ModelProviderError({
      code: "provider_unavailable",
      transient: true,
    });
  }
}

async function listenOnLoopback(
  server: Server,
  address: typeof LISTEN_ADDRESS,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(address.port, address.host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
    server.closeAllConnections();
  });
}

function parseGatewayRequest(
  requestUrl: string | undefined,
): { capability: string; suffix: string } | undefined {
  if (requestUrl === undefined || !requestUrl.startsWith("/")) return undefined;
  const url = new URL(requestUrl, "http://127.0.0.1");
  const match = url.pathname.match(/^\/pi\/([^/]+)\/(.*)$/u);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { capability: match[1], suffix: `${match[2]}${url.search}` };
}

function parseBearerCapability(request: IncomingMessage): string | undefined {
  let value: string | undefined;
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() !== "authorization") continue;
    count += 1;
    value = request.rawHeaders[index + 1];
  }
  if (count !== 1 || value === undefined) return undefined;
  const match = value.match(/^Bearer ([A-Za-z0-9_-]+)$/u);
  return match?.[1];
}

function fixedCapabilityBytes(capability: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(capability)) return undefined;
  const bytes = Buffer.from(capability, "ascii");
  return bytes;
}

function providerRequestUrl(baseUrl: string, suffix: string): URL | undefined {
  if (suffix.startsWith("/") || suffix.startsWith("\\")) return undefined;
  try {
    const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    const target = new URL(suffix, base);
    const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
    if (target.origin !== base.origin || !target.pathname.startsWith(basePath)) {
      return undefined;
    }
    return target;
  } catch {
    return undefined;
  }
}

function safeRequestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (!SAFE_REQUEST_HEADERS.has(name.toLowerCase()) || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

function sendEmpty(response: ServerResponse, status: number): void {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  response.writeHead(status, { "content-length": "0" });
  response.end();
}

function sendGatewayError(
  response: ServerResponse,
  status: number,
  retryAfterMs: number | undefined,
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    ...retryAfterHeader(retryAfterMs),
  });
  response.end(JSON.stringify({
    error: {
      message: [
        `pi_gateway_error status=${String(status)}`,
        ...(retryAfterMs === undefined ? [] : [`retry_after_ms=${String(retryAfterMs)}`]),
      ].join(" "),
    },
  }));
}

function retryAfterHeader(retryAfterMs: number | undefined): Record<string, string> {
  return retryAfterMs === undefined ? {} : { "retry-after": String(retryAfterMs / 1_000) };
}

function retryAfterMilliseconds(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  const milliseconds = Math.round(seconds * 1_000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function providerErrorMetadata(error: unknown): {
  status: number;
  retryAfterMs?: number;
} | undefined {
  if (!(error instanceof ModelProviderError) || error.status === undefined) return undefined;
  return {
    status: error.status,
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
  };
}

function providerErrorStatus(error: unknown): number {
  if (typeof error !== "object" || error === null) return 502;
  const status = "status" in error ? error.status : undefined;
  if (typeof status === "number" && status >= 400 && status <= 599) return status;
  const code = "code" in error ? error.code : undefined;
  if (code === "provider_auth_failed") return 401;
  if (code === "provider_rate_limited") return 429;
  if (code === "provider_unavailable") return 503;
  return 502;
}

function freezeRuntime(model: EffectiveModelRuntime): EffectiveModelRuntime {
  return deepFreeze(structuredClone(model));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
