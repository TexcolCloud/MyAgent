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
const SAFE_RESPONSE_HEADERS = new Set(["content-type"]);

export class ProviderEgressGateway {
  private readonly capabilities = new Map<string, EffectiveModelRuntime>();
  private readonly activeRequests = new Set<AbortController>();
  private server: Server | undefined;
  private listenerBaseUrl: string | undefined;
  private stopped = false;

  constructor(private readonly options: ProviderEgressGatewayOptions) {}

  get baseUrl(): string {
    if (this.listenerBaseUrl === undefined) throw new Error("provider_gateway_not_started");
    return this.listenerBaseUrl;
  }

  async start(): Promise<this> {
    if (this.stopped) throw new Error("provider_gateway_stopped");
    if (this.server !== undefined) return this;
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    try {
      await (this.options.listen ?? listenOnLoopback)(server, LISTEN_ADDRESS);
      const address = server.address();
      if (
        address === null || typeof address === "string" ||
        address.address !== LISTEN_ADDRESS.host || address.family !== "IPv4"
      ) {
        throw new Error("provider_gateway_non_loopback_binding");
      }
      this.listenerBaseUrl = `http://${LISTEN_ADDRESS.host}:${String(address.port)}`;
      return this;
    } catch (error) {
      await closeServer(server);
      this.server = undefined;
      throw error;
    }
  }

  routeFor(model: EffectiveModelRuntime): PiGatewayRoute {
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

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.listenerBaseUrl = undefined;
    this.capabilities.clear();
    for (const controller of this.activeRequests) controller.abort();
    this.activeRequests.clear();
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) await closeServer(server);
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
