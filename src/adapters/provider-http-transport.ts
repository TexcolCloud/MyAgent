import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import { isIP } from "node:net";

import type {
  ProviderHttpConnectionRuntime,
  ProviderHttpTransport,
  ProviderHttpTransportInput,
} from "../ports/provider-http-transport.js";
import type { SecretResolver } from "../ports/secret-resolver.js";
import {
  createPinnedLookup,
  normalizeProviderBaseUrl,
  parseProviderUrl,
  resolveAndValidateProviderAddress,
  resolveWithNode,
  type ProviderAddressResolver,
  type ResolvedProviderAddress,
  unbracket,
  validateLiteralAddress,
  validateRequestUrl,
} from "./provider-http-policy.js";
import {
  abortError,
  errorForStatus,
  firstHeader,
  isRedirectStatus,
  MAX_REDIRECTS,
  normalizeRequestError,
  parseRedirectUrl,
  protocolError,
  ProviderTimeoutError,
  providerError,
  redirectRequest,
} from "./provider-http-response-policy.js";
import {
  responseFromIncoming,
  writeRequestBody,
} from "./provider-http-streams.js";

export {
  classifyProviderAddress,
  isProviderAddressAllowed,
  normalizeProviderBaseUrl,
} from "./provider-http-policy.js";
export type {
  ProviderAddressClass,
  ProviderAddressResolver,
  ResolvedProviderAddress,
} from "./provider-http-policy.js";

export interface NodeProviderHttpTransportOptions {
  readonly secretResolver: SecretResolver;
  readonly resolveAddresses?: ProviderAddressResolver;
  readonly connectTimeoutMs?: number;
  readonly tlsCa?: string | Buffer | (string | Buffer)[];
}

interface RequestContext {
  readonly baseOrigin: string;
  readonly connection: ProviderHttpConnectionRuntime;
  readonly deadline: number;
  readonly maxResponseBytes: number;
  bearerToken?: string;
}

interface RawResponse {
  readonly message: IncomingMessage;
  readonly url: URL;
}

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
    const selectedAddress = await resolveAndValidateProviderAddress(
      this.resolveAddresses,
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

  private resolveBearerToken(connection: ProviderHttpConnectionRuntime): string {
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
    headers.set("accept-encoding", "identity");
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
      void writeRequestBody(request.body, clientRequest, request.signal).catch(finishReject);
    });
  }
}
