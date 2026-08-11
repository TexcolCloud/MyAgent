import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProviderEgressGateway } from "../../src/adapters/provider-egress-gateway.js";
import {
  NodeProviderHttpTransport,
  type ProviderAddressResolver,
} from "../../src/adapters/provider-http-transport.js";
import type { SecretResolver } from "../../src/ports/secret-resolver.js";
import { testModelRuntime } from "../helpers/model-fixtures.js";

describe("ProviderEgressGateway", () => {
  const gateways: ProviderEgressGateway[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
    await Promise.all(servers.splice(0).map(closeServer));
  });

  it("accepts only an opaque loopback route and applies the controlled provider fetch", async () => {
    const requests: Array<{
      authorization?: string;
      body: string;
      method?: string;
      path?: string;
    }> = [];
    const provider = await startServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          ...(request.headers.authorization === undefined
            ? {}
            : { authorization: request.headers.authorization }),
          body: Buffer.concat(chunks).toString("utf8"),
          ...(request.method === undefined ? {} : { method: request.method }),
          ...(request.url === undefined ? {} : { path: request.url }),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"data":[]}');
      });
    });
    servers.push(provider.server);
    const secretValue = "provider-secret-value";
    const resolveSecret = vi.fn(() => secretValue);
    const resolveAddresses = vi.fn<ProviderAddressResolver>(async () => [
      { address: "127.0.0.1", family: 4 as const },
    ]);
    const transport = new NodeProviderHttpTransport({
      secretResolver: { resolve: resolveSecret } satisfies SecretResolver,
      resolveAddresses,
    });
    const gateway = await new ProviderEgressGateway({
      transport,
      randomBytes: () => Buffer.alloc(32, 0x2a),
    }).start();
    gateways.push(gateway);
    const runtime = testModelRuntime({
      baseUrl: `http://provider.test:${String(provider.port)}/v1`,
      allowInsecureHttp: true,
    });

    const route = gateway.routeFor(runtime);

    expect(route.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/pi\/[^/]+$/u);
    expect(route.baseUrl).not.toContain(runtime.baseUrl);
    expect(route.apiKey).not.toBe(secretValue);
    expect(resolveSecret).not.toHaveBeenCalled();

    const response = await fetch(`${route.baseUrl}/models`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${route.apiKey}`,
        "content-type": "application/json",
      },
      body: '{"input":"hello"}',
    });

    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toEqual({ data: [] });
    expect(requests).toEqual([{
      authorization: `Bearer ${secretValue}`,
      body: '{"input":"hello"}',
      method: "POST",
      path: "/v1/models",
    }]);
    expect(resolveSecret).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing route capability before contacting the provider", async () => {
    const resolveAddresses = vi.fn<ProviderAddressResolver>(async () => [
      { address: "127.0.0.1", family: 4 as const },
    ]);
    const gateway = await new ProviderEgressGateway({
      transport: new NodeProviderHttpTransport({
        secretResolver: { resolve: () => "must-not-resolve" },
        resolveAddresses,
      }),
      randomBytes: () => Buffer.alloc(32, 0x2b),
    }).start();
    gateways.push(gateway);

    const response = await fetch(`${gateway.baseUrl}/pi/missing/models`, {
      headers: { authorization: "Bearer missing" },
    });

    expect(response.status).toBe(401);
    expect(resolveAddresses).not.toHaveBeenCalled();
  });

  it("requires the route capability as the only bearer credential", async () => {
    const createFetch = vi.fn(() => vi.fn(async () => new Response("unused")));
    const gateway = await new ProviderEgressGateway({
      transport: { createFetch },
      randomBytes: () => Buffer.alloc(32, 0x2c),
    }).start();
    gateways.push(gateway);
    const route = gateway.routeFor(testModelRuntime());

    const missing = await fetch(`${route.baseUrl}/models`);
    const wrong = await fetch(`${route.baseUrl}/models`, {
      headers: { authorization: "Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    });

    expect([missing.status, wrong.status]).toEqual([401, 401]);
    expect(createFetch).not.toHaveBeenCalled();
  });

  it("rejects a listener seam that binds beyond exact IPv4 loopback and closes it", async () => {
    let attemptedServer: Server | undefined;
    const gateway = new ProviderEgressGateway({
      transport: { createFetch: () => vi.fn() },
      listen: async (server) => {
        attemptedServer = server;
        await listen(server, "0.0.0.0");
      },
    });

    await expect(gateway.start()).rejects.toThrow("provider_gateway_non_loopback_binding");
    expect(attemptedServer?.listening).toBe(false);
  });

  it("fails closed for Pi route issuance after gateway startup is unavailable", async () => {
    const createFetch = vi.fn(() => vi.fn(async () => new Response("must-not-run")));
    const gateway = new ProviderEgressGateway({
      transport: { createFetch },
      listen: async () => { throw new Error("listener_unavailable"); },
    });
    gateways.push(gateway);

    await expect(gateway.start()).rejects.toThrow("listener_unavailable");
    expect(gateway.isAvailable).toBe(false);
    const error = thrownBy(() => gateway.routeFor(testModelRuntime()));

    expect(error).toMatchObject({ code: "provider_unavailable", transient: true });
    expect(createFetch).not.toHaveBeenCalled();
  });

  it("waits for concurrent start and closes a listener that binds during stop", async () => {
    let server: Server | undefined;
    let releaseListen: (() => void) | undefined;
    const listenReleased = new Promise<void>((resolve) => { releaseListen = resolve; });
    let releaseEntered: (() => void) | undefined;
    const listenEntered = new Promise<void>((resolve) => { releaseEntered = resolve; });
    const gateway = new ProviderEgressGateway({
      transport: { createFetch: () => vi.fn(async () => new Response("unused")) },
      listen: async (candidate, address) => {
        server = candidate;
        releaseEntered?.();
        await listenReleased;
        await listen(candidate, address.host);
      },
    });
    gateways.push(gateway);

    const firstStart = gateway.start();
    await listenEntered;
    const secondStart = gateway.start();
    const secondSettledBeforeListener = await settlesWithin(secondStart, 25);
    const stop = gateway.stop();
    releaseListen?.();

    expect(secondSettledBeforeListener).toBe(false);
    await expect(Promise.all([firstStart, secondStart])).rejects.toThrow();
    await stop;
    expect(server?.listening).toBe(false);
  });

  it("rejects a host escape before constructing a controlled provider fetch", async () => {
    const createFetch = vi.fn(() => vi.fn(async () => new Response("unused")));
    const gateway = await new ProviderEgressGateway({
      transport: { createFetch },
      randomBytes: () => Buffer.alloc(32, 0x2d),
    }).start();
    gateways.push(gateway);
    const route = gateway.routeFor(testModelRuntime());

    const response = await fetch(`${route.baseUrl}/https://escape.invalid/models`, {
      headers: { authorization: `Bearer ${route.apiKey}` },
    });

    expect(response.status).toBe(400);
    expect(createFetch).not.toHaveBeenCalled();
  });

  it("keeps a frozen runtime and forwards only safe request headers", async () => {
    const requests: Array<Record<string, string | string[] | undefined>> = [];
    const provider = await startServer((request, response) => {
      requests.push(request.headers);
      response.end("ok");
    });
    servers.push(provider.server);
    const transport = new NodeProviderHttpTransport({
      secretResolver: { resolve: () => "provider-owned-secret" },
    });
    const gateway = await new ProviderEgressGateway({
      transport,
      randomBytes: () => Buffer.alloc(32, 0x2e),
    }).start();
    gateways.push(gateway);
    const runtime = testModelRuntime({
      baseUrl: `http://127.0.0.1:${String(provider.port)}/v1`,
      allowInsecureHttp: true,
    });
    const route = gateway.routeFor(runtime);
    runtime.baseUrl = "http://169.254.169.254/latest";

    const response = await fetch(`${route.baseUrl}/models`, {
      headers: {
        authorization: `Bearer ${route.apiKey}`,
        cookie: "local-cookie",
        "x-api-key": "sdk-credential",
        "x-forwarded-host": "escape.invalid",
        accept: "application/json",
      },
    });

    expect(await response.text()).toBe("ok");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      accept: "application/json",
      authorization: "Bearer provider-owned-secret",
    });
    expect(requests[0]).not.toHaveProperty("cookie");
    expect(requests[0]).not.toHaveProperty("x-api-key");
    expect(requests[0]).not.toHaveProperty("x-forwarded-host");
  });

  it("reuses transport redirect policy and never contacts a cross-origin target", async () => {
    let targetRequests = 0;
    const target = await startServer((_request, response) => {
      targetRequests += 1;
      response.end("must-not-arrive");
    });
    servers.push(target.server);
    const source = await startServer((_request, response) => {
      response.writeHead(302, {
        location: `http://127.0.0.1:${String(target.port)}/escaped`,
      });
      response.end();
    });
    servers.push(source.server);
    const gateway = await new ProviderEgressGateway({
      transport: new NodeProviderHttpTransport({
        secretResolver: { resolve: () => "unused" },
      }),
      randomBytes: () => Buffer.alloc(32, 0x2f),
    }).start();
    gateways.push(gateway);
    const route = gateway.routeFor(testModelRuntime({
      baseUrl: `http://127.0.0.1:${String(source.port)}/v1`,
      providerAuth: { type: "none" },
      allowInsecureHttp: true,
    }));

    const response = await fetch(`${route.baseUrl}/models`, {
      headers: { authorization: `Bearer ${route.apiKey}` },
    });

    expect(response.status).toBe(502);
    expect(targetRequests).toBe(0);
  });

  it("aborts the controlled provider request when the loopback caller aborts", async () => {
    let releaseProviderHit: (() => void) | undefined;
    const providerHit = new Promise<void>((resolve) => { releaseProviderHit = resolve; });
    let releaseProviderClose: (() => void) | undefined;
    const providerClosed = new Promise<void>((resolve) => { releaseProviderClose = resolve; });
    const provider = await startServer((request) => {
      releaseProviderHit?.();
      request.socket.once("close", () => releaseProviderClose?.());
    });
    servers.push(provider.server);
    const gateway = await new ProviderEgressGateway({
      transport: new NodeProviderHttpTransport({
        secretResolver: { resolve: () => "unused" },
      }),
      randomBytes: () => Buffer.alloc(32, 0x30),
      timeoutMs: 5_000,
    }).start();
    gateways.push(gateway);
    const route = gateway.routeFor(testModelRuntime({
      baseUrl: `http://127.0.0.1:${String(provider.port)}/v1`,
      providerAuth: { type: "none" },
      allowInsecureHttp: true,
    }));
    const controller = new AbortController();
    const request = fetch(`${route.baseUrl}/models`, {
      headers: { authorization: `Bearer ${route.apiKey}` },
      signal: controller.signal,
    });
    await providerHit;

    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    await expect(Promise.race([
      providerClosed.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ])).resolves.toBe(true);
  });

  it("removes capabilities and closes the listener on stop", async () => {
    let stopped = 0;
    const gateway = await new ProviderEgressGateway({
      transport: { createFetch: () => vi.fn(async () => new Response("unused")) },
      randomBytes: () => Buffer.alloc(32, 0x31),
      onStopped: () => { stopped += 1; },
    }).start();
    gateways.push(gateway);
    const route = gateway.routeFor(testModelRuntime());

    await gateway.stop();
    await gateway.stop();

    expect(stopped).toBe(1);
    expect(thrownBy(() => gateway.routeFor(testModelRuntime())))
      .toMatchObject({ code: "provider_unavailable", transient: true });
    await expect(fetch(`${route.baseUrl}/models`, {
      headers: { authorization: `Bearer ${route.apiKey}` },
      signal: AbortSignal.timeout(1_000),
    })).rejects.toThrow();
  });
});

async function startServer(
  listener: RequestListener,
): Promise<{ server: Server; port: number }> {
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { server, port: (server.address() as AddressInfo).port };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function listen(server: Server, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.removeAllListeners("error");
      resolve();
    });
  });
}

function thrownBy(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("expected_operation_to_throw");
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    promise.then(
      () => {
        clearTimeout(timeout);
        resolve(true);
      },
      () => {
        clearTimeout(timeout);
        resolve(true);
      },
    );
  });
}
