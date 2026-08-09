import {
  createServer as createHttpServer,
  type RequestListener,
  type Server as HttpServer,
} from "node:http";
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from "node:https";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import type { TLSSocket } from "node:tls";

import { afterEach, describe, expect, it } from "vitest";

import {
  NodeProviderHttpTransport,
  type ProviderAddressResolver,
} from "../../src/adapters/provider-http-transport.js";
import {
  parseProviderConnectionId,
  providerConnectionRevisionIdFromUuid,
} from "../../src/domain/ids.js";
import type { ProviderConnectionRevision } from "../../src/domain/provider-connection.js";
import type { SecretResolver } from "../../src/ports/secret-resolver.js";

describe("NodeProviderHttpTransport", () => {
  const servers: TestServer[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            if ("closeAllConnections" in server) server.closeAllConnections();
          }),
      ),
    );
  });

  it("re-resolves every request and pins the validated address", async () => {
    const local = await startHttpServer((_request, response) => response.end("ok"));
    servers.push(local.server);
    let resolutions = 0;
    const resolveAddresses: ProviderAddressResolver = async () => {
      resolutions += 1;
      return resolutions === 1
        ? [{ address: "127.0.0.1", family: 4 }]
        : [{ address: "169.254.169.254", family: 4 }];
    };
    const providerFetch = transport({ resolveAddresses }).createFetch({
      connection: connection(`http://rebind.test:${String(local.port)}`),
      timeoutMs: 500,
      maxResponseBytes: 64,
    });

    await expect(providerFetch(`http://rebind.test:${String(local.port)}`)).resolves.toBeInstanceOf(
      Response,
    );
    await expect(providerFetch(`http://rebind.test:${String(local.port)}`)).rejects.toMatchObject({
      code: "insecure_provider_url",
    });
    expect(resolutions).toBe(2);
  });

  it("rejects mixed DNS results before opening a socket", async () => {
    const resolveAddresses: ProviderAddressResolver = async () => [
      { address: "127.0.0.1", family: 4 },
      { address: "8.8.8.8", family: 4 },
    ];
    const providerFetch = transport({ resolveAddresses }).createFetch({
      connection: connection("http://mixed.test", { allowInsecureHttp: true }),
      timeoutMs: 100,
      maxResponseBytes: 64,
    });

    await expect(providerFetch("http://mixed.test/v1/models")).rejects.toMatchObject({
      code: "insecure_provider_url",
    });
  });

  it("streams request and response bodies while replacing SDK authorization", async () => {
    const requests: Array<{ body: string; authorization?: string; authorizationCount: number }> = [];
    const local = await startHttpServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const authorizationIndexes = request.rawHeaders
          .map((value, index) => ({ value, index }))
          .filter(({ value, index }) => index % 2 === 0 && value.toLowerCase() === "authorization");
        requests.push({
          body: Buffer.concat(chunks).toString("utf8"),
          ...(request.headers.authorization === undefined
            ? {}
            : { authorization: request.headers.authorization }),
          authorizationCount: authorizationIndexes.length,
        });
        response.write("response-");
        response.end("stream");
      });
    });
    servers.push(local.server);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("request-"));
        controller.enqueue(new TextEncoder().encode("stream"));
        controller.close();
      },
    });
    const providerFetch = transport({ secret: "resolved-secret-value" }).createFetch({
      connection: connection(local.url, {
        auth: { type: "bearer", secret: { fromEnvironment: "PROVIDER_KEY" } },
      }),
      timeoutMs: 500,
      maxResponseBytes: 64,
    });

    const response = await providerFetch(local.url, {
      method: "POST",
      headers: { Authorization: "sdk-secret-value" },
      body,
      duplex: "half",
    } as RequestInit);

    await expect(response.text()).resolves.toBe("response-stream");
    expect(requests).toEqual([
      {
        body: "request-stream",
        authorization: "Bearer resolved-secret-value",
        authorizationCount: 1,
      },
    ]);
  });

  it("strips SDK authorization when the connection has no auth", async () => {
    let authorization: string | undefined;
    const local = await startHttpServer((request, response) => {
      authorization = request.headers.authorization;
      response.end("ok");
    });
    servers.push(local.server);
    const providerFetch = transport().createFetch({
      connection: connection(local.url),
      timeoutMs: 500,
      maxResponseBytes: 64,
    });

    await providerFetch(new Request(local.url, { headers: { Authorization: "sdk-secret" } }));

    expect(authorization).toBeUndefined();
  });

  it("contains invalid resolved bearer values without opening a socket", async () => {
    let requests = 0;
    const local = await startHttpServer((_request, response) => {
      requests += 1;
      response.end("must-not-reach");
    });
    servers.push(local.server);
    const invalidSecret = "resolved-secret\r\ninjected-header";
    const providerFetch = transport({ secret: invalidSecret }).createFetch({
      connection: connection(local.url, {
        auth: { type: "bearer", secret: { fromEnvironment: "SECRET_NAME" } },
      }),
      timeoutMs: 500,
      maxResponseBytes: 64,
    });

    const error = await providerFetch(local.url).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "secret_locked", transient: false });
    expect(String(error)).not.toContain(invalidSecret);
    expect(String(error)).not.toContain("SECRET_NAME");
    expect(requests).toBe(0);
  });

  it("follows same-origin redirects through revalidation", async () => {
    const authorizations: Array<string | undefined> = [];
    const paths: string[] = [];
    const local = await startHttpServer((request, response) => {
      paths.push(request.url ?? "");
      authorizations.push(request.headers.authorization);
      if (request.url === "/start") {
        response.writeHead(302, { location: "/end" });
        response.end();
        return;
      }
      response.end("redirected");
    });
    servers.push(local.server);
    let resolutions = 0;
    const providerFetch = transport({
      secret: "redirect-token",
      resolveAddresses: async () => {
        resolutions += 1;
        return [{ address: "127.0.0.1", family: 4 }];
      },
    }).createFetch({
      connection: connection(`http://redirect.test:${String(local.port)}`, {
        auth: { type: "bearer", secret: { fromEnvironment: "REDIRECT_KEY" } },
      }),
      timeoutMs: 500,
      maxResponseBytes: 64,
    });

    const response = await providerFetch(`http://redirect.test:${String(local.port)}/start`);

    await expect(response.text()).resolves.toBe("redirected");
    expect(paths).toEqual(["/start", "/end"]);
    expect(authorizations).toEqual(["Bearer redirect-token", "Bearer redirect-token"]);
    expect(resolutions).toBe(2);
  });

  it("rejects cross-origin redirects without contacting or authorizing the target", async () => {
    let targetRequests = 0;
    const target = await startHttpServer((_request, response) => {
      targetRequests += 1;
      response.end("must-not-reach");
    });
    servers.push(target.server);
    const source = await startHttpServer((_request, response) => {
      response.writeHead(302, {
        location: `http://other.test:${String(target.port)}/secret`,
      });
      response.end();
    });
    servers.push(source.server);
    const providerFetch = transport({
      secret: "must-not-forward",
      resolveAddresses: async () => [{ address: "127.0.0.1", family: 4 }],
    }).createFetch({
      connection: connection(`http://origin.test:${String(source.port)}`, {
        auth: { type: "bearer", secret: { fromEnvironment: "CROSS_ORIGIN_KEY" } },
      }),
      timeoutMs: 500,
      maxResponseBytes: 64,
    });

    await expect(
      providerFetch(`http://origin.test:${String(source.port)}/redirect`),
    ).rejects.toMatchObject({ code: "invalid_provider_url" });
    expect(targetRequests).toBe(0);
  });

  it("preserves the TLS hostname and SNI while pinning the socket address", async () => {
    let servername: string | false | null | undefined;
    const server = createHttpsServer({ key: TLS_KEY, cert: TLS_CERT }, (request, response) => {
      servername = (request.socket as TLSSocket).servername;
      response.end("secure");
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const url = `https://provider.test:${String(address.port)}`;
    const providerFetch = transport({
      resolveAddresses: async () => [{ address: "127.0.0.1", family: 4 }],
      tlsCa: TLS_CERT,
    }).createFetch({
      connection: connection(url),
      timeoutMs: 500,
      maxResponseBytes: 64,
    });

    const response = await providerFetch(url);

    await expect(response.text()).resolves.toBe("secure");
    expect(servername).toBe("provider.test");
  });

  it("does not disable TLS hostname verification", async () => {
    const server = createHttpsServer({ key: TLS_KEY, cert: TLS_CERT }, (_request, response) => {
      response.end("must-not-trust-wrong-host");
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const url = `https://127.0.0.1:${String(address.port)}`;
    const providerFetch = transport({ tlsCa: TLS_CERT }).createFetch({
      connection: connection(url),
      timeoutMs: 500,
      maxResponseBytes: 64,
    });

    await expect(providerFetch(url)).rejects.toMatchObject({
      code: "provider_unavailable",
      transient: true,
    });
  });

  it("maps request timeout to a safe provider-unavailable error", async () => {
    const local = await startHttpServer(() => undefined);
    servers.push(local.server);
    const providerFetch = transport().createFetch({
      connection: connection(local.url),
      timeoutMs: 40,
      maxResponseBytes: 64,
    });

    const error = await providerFetch(local.url).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "provider_unavailable", transient: true });
    expect(String(error)).toBe("ModelProviderError: provider_unavailable");
    expect(error).not.toHaveProperty("cause");
  });

  it("maps cancellation to AbortError", async () => {
    const local = await startHttpServer(() => undefined);
    servers.push(local.server);
    const controller = new AbortController();
    const providerFetch = transport().createFetch({
      connection: connection(local.url),
      timeoutMs: 500,
      maxResponseBytes: 64,
    });
    const pending = providerFetch(local.url, { signal: controller.signal });
    controller.abort("secret abort reason");

    const error = await Promise.race([
      pending.catch((cause: unknown) => cause),
      new Promise<{ name: string }>((resolve) => {
        setTimeout(() => resolve({ name: "abort_not_observed" }), 100);
      }),
    ]);

    expect(error).toMatchObject({ name: "AbortError" });
    expect(String(error)).not.toContain("secret abort reason");
  });

  it("enforces the response-byte cap while streaming", async () => {
    const local = await startHttpServer((_request, response) => {
      response.write("123");
      response.end("456");
    });
    servers.push(local.server);
    const providerFetch = transport().createFetch({
      connection: connection(local.url),
      timeoutMs: 500,
      maxResponseBytes: 5,
    });

    const error = await providerFetch(local.url)
      .then(async (response) => response.text())
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "model_protocol_error", transient: false });
    expect(String(error)).toBe("ModelProviderError: model_protocol_error");
  });

  it.each([401, 403])("maps HTTP %i without exposing auth, body, code, or Secret data", async (status) => {
    const local = await startHttpServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end('{"code":"raw_provider_code","message":"raw-provider-body"}');
    });
    servers.push(local.server);
    const providerFetch = transport({ secret: "resolved-provider-secret" }).createFetch({
      connection: connection(local.url, {
        auth: { type: "bearer", secret: { fromEnvironment: "SECRET_REFERENCE_NAME" } },
      }),
      timeoutMs: 500,
      maxResponseBytes: 64,
    });

    const error = await providerFetch(local.url).catch((cause: unknown) => cause);
    const serialized = JSON.stringify(error);

    expect(error).toMatchObject({
      code: "provider_auth_failed",
      transient: false,
      status,
    });
    for (const leaked of [
      "raw_provider_code",
      "raw-provider-body",
      "resolved-provider-secret",
      "SECRET_REFERENCE_NAME",
    ]) {
      expect(`${String(error)} ${serialized}`).not.toContain(leaked);
    }
    expect(error).not.toHaveProperty("cause");
  });

  it("maps 429 and bounds Retry-After", async () => {
    const local = await startHttpServer((_request, response) => {
      response.writeHead(429, { "retry-after": "999999" });
      response.end("raw-rate-body");
    });
    servers.push(local.server);
    const providerFetch = transport().createFetch({
      connection: connection(local.url),
      timeoutMs: 500,
      maxResponseBytes: 64,
    });

    await expect(providerFetch(local.url)).rejects.toMatchObject({
      code: "provider_rate_limited",
      transient: true,
      status: 429,
      retryAfterMs: 30_000,
    });
  });

  it.each([404, 405, 501])("keeps endpoint status %i without inferring fallback evidence", async (status) => {
    const local = await startHttpServer((_request, response) => {
      response.writeHead(status);
      response.end("unsupported_endpoint");
    });
    servers.push(local.server);
    const providerFetch = transport().createFetch({
      connection: connection(local.url),
      timeoutMs: 500,
      maxResponseBytes: 64,
    });

    const error = await providerFetch(local.url).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "model_protocol_error",
      transient: false,
      status,
    });
    expect(JSON.stringify(error)).not.toContain("unsupported_endpoint");
  });

  it("maps provider server failures to provider_unavailable", async () => {
    const local = await startHttpServer((_request, response) => {
      response.writeHead(503, { "retry-after": "1" });
      response.end("raw-provider-outage");
    });
    servers.push(local.server);
    const providerFetch = transport().createFetch({
      connection: connection(local.url),
      timeoutMs: 500,
      maxResponseBytes: 64,
    });

    await expect(providerFetch(local.url)).rejects.toMatchObject({
      code: "provider_unavailable",
      transient: true,
      status: 503,
      retryAfterMs: 1_000,
    });
  });

  it("maps malformed HTTP responses to a cause-free protocol error", async () => {
    let peerSocket: Socket | undefined;
    const server = createNetServer((socket) => {
      peerSocket = socket;
      socket.end("HTTP/1.1 200 OK\r\nMalformed Header\r\n\r\nraw-malformed-body");
    });
    await listen(server);
    servers.push(server);
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${String(address.port)}`;
    const providerFetch = transport().createFetch({
      connection: connection(url),
      timeoutMs: 500,
      maxResponseBytes: 64,
    });

    const error = await providerFetch(url).catch((cause: unknown) => cause);
    peerSocket?.destroy();

    expect(error).toMatchObject({ code: "model_protocol_error", transient: false });
    expect(String(error)).not.toContain("Malformed Header");
    expect(error).not.toHaveProperty("cause");
  });
});

function transport(options?: {
  readonly resolveAddresses?: ProviderAddressResolver;
  readonly secret?: string;
  readonly tlsCa?: string;
}): NodeProviderHttpTransport {
  const secretResolver: SecretResolver = {
    resolve: () => options?.secret ?? "unused-secret",
  };
  return new NodeProviderHttpTransport({
    secretResolver,
    ...(options?.resolveAddresses === undefined
      ? {}
      : { resolveAddresses: options.resolveAddresses }),
    ...(options?.tlsCa === undefined ? {} : { tlsCa: options.tlsCa }),
  });
}

function connection(
  baseUrl: string,
  overrides?: Partial<Pick<ProviderConnectionRevision, "allowInsecureHttp" | "auth">>,
): ProviderConnectionRevision {
  return {
    revisionId: providerConnectionRevisionIdFromUuid("00000000-0000-4000-8000-000000000006"),
    connectionId: parseProviderConnectionId("provider"),
    state: "draft",
    baseUrl,
    auth: overrides?.auth ?? { type: "none" },
    allowInsecureHttp: overrides?.allowInsecureHttp ?? false,
    protocolPreference: "responses",
    presetVersion: "test-v1",
    createdAt: new Date(0),
  };
}

async function startHttpServer(
  handler: RequestListener,
): Promise<{ server: HttpServer; port: number; url: string }> {
  const server = createHttpServer(handler);
  await listen(server);
  const address = server.address() as AddressInfo;
  return {
    server,
    port: address.port,
    url: `http://127.0.0.1:${String(address.port)}`,
  };
}

type TestServer = HttpServer | HttpsServer | NetServer;

async function listen(server: TestServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC3PwCarNEXG5uM
3kwMvIoTnGPnvY90CeF6Ovz5XjSuVREmECpAp4y6JgmBa6ekJ55X0YotphXtBntd
E3qYESijvTSRPGIK1Qqhi3J9OJOe3mB2WbXcamv12GKQfCdMFdtRts5zgKEdoUne
Q0P5gSXB/3P1xIAPIPZti7ArYI96Ik0HHj9z/r0IcBGna+cyRil/LMW0j9c9W58P
59ocb8SNDZ5dvYuBr1iIrSeO6GtTRZJFA7Mg4pWZLuuoSk90OAm0izm/w1ptzHIL
MX7c67bkshMGMOEdAMLvJEZIi/YoA2IzunpT5QhyIZgCr8P6jceXmHbgDkSOzJ6d
tWfTB+hNAgMBAAECggEACftimwpi8XFNjeTmG6OBmgPg5VTMJbQMFk50TVk2YXC8
2Gf1BUSbQ+Cij+w/W4/U7k+5yTbM5vZ9bdqLyRDWN+UsoeS6KoDkbVxdRjj4waS3
eHr2jyU08FVzOQ+qTFi8c70TjfMp06Vfkr3zS/ofBmxV8sNbfnd7NQhw9kvyROLV
lCVB2SVvJ2ofTLEFUwawLyRAro1tKqjAco6G3njEtlm+8TrxU0N2YYw3g+qQ1tdr
xw1mkb/a+Oa7EWFpUsIh/SF1UbIdGp0ypwQZ0WcP7FJlszJ+7y+C2vC/dQZu+k1M
RLcx1+f7Kx/vH0nBjicZ16lXxiYy6ynHVGkUZLCdAQKBgQD8RXfKVoNqMtO0/hXJ
ukhlTPnn/El0bTSZ7R59vZ4fNFH6UWlwK69ZdE3ilEpnSWZKIqXPsycty+7Mk99T
ffhP6spYiRp/1ZQ7t0BbdP3V/9qH0bUJXM9SgfBsABYPDtpkJMCI+j6EHfE7gE4O
hQgMoorVZ7ZqLWX0mwqNJYXt7QKBgQC59Fwq8IAI6eJxHJ74UfwaHYPo2UDQF0sU
9h0oYbaZOCT1ud8uigEGm7cbqkw2tRgH2W0eJbTBq5GVrY2kCO6kL1UkG066/ZgR
T5XddDMyiuV0JNZUZz4OlWNLmVsVXo3q1vBLMaZL4vQbvYzRJSler2kr535bElP8
CBaAxYeX4QKBgBa562C/Cne2vHvBqBTUQ1Fc7eaIQ9XJQMPdKLILMwN8oyX5z5Xb
WaClaZ7P3SQQ6LYlCOr9KLpndMvZRnUvE/+fFzuCnnCFvSTkDVgv4e41bmpt6fE9
+y9jpVUVbOdOXz5GUVIFuTwNtn21wVJtiZwZyIgRH83Q6S5wCTNN/hLBAoGBAIES
BJtlXWlSdfNPC2SO+25hCDsp+Nu3H01IWwq5cBW/q5/HyQqzjWy5zonsVYQvhKOG
HkArqeA3pxB+a27tKD9b/zvVnHscJF33oK0ax6KQWB2aqA3jr2ZN+KLzqg4WGGll
kVqP9r57pDZRBhnxMlrfZB+uSb0K5rJsJrpw4OHhAoGBALxNH/MS9IRzLap0a0pt
PYymaE8kyiNjg57Q/uni1g/DW85HF8n5JpvSCpOzKx0xsHgj5QLVKDxqz8XhHlJO
JNLu3y62AUirqsGFktTGD5d/sfuVjpNaunSVsE7eAmNn92e1tRawnUCL8DllKsZj
76dBszOMVLHfdBYN461rlupU
-----END PRIVATE KEY-----`;

const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDKzCCAhOgAwIBAgIUfp3hK3ZF8NGJJxOI6z2XMPb7QokwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNcHJvdmlkZXIudGVzdDAeFw0yNjA4MDkxNDE5MzBaFw0z
NjA4MDYxNDE5MzBaMBgxFjAUBgNVBAMMDXByb3ZpZGVyLnRlc3QwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQC3PwCarNEXG5uM3kwMvIoTnGPnvY90CeF6
Ovz5XjSuVREmECpAp4y6JgmBa6ekJ55X0YotphXtBntdE3qYESijvTSRPGIK1Qqh
i3J9OJOe3mB2WbXcamv12GKQfCdMFdtRts5zgKEdoUneQ0P5gSXB/3P1xIAPIPZt
i7ArYI96Ik0HHj9z/r0IcBGna+cyRil/LMW0j9c9W58P59ocb8SNDZ5dvYuBr1iI
rSeO6GtTRZJFA7Mg4pWZLuuoSk90OAm0izm/w1ptzHILMX7c67bkshMGMOEdAMLv
JEZIi/YoA2IzunpT5QhyIZgCr8P6jceXmHbgDkSOzJ6dtWfTB+hNAgMBAAGjbTBr
MB0GA1UdDgQWBBQeFcDgNIFeX8bIoy57PK9u+ZZ3NzAfBgNVHSMEGDAWgBQeFcDg
NIFeX8bIoy57PK9u+ZZ3NzAPBgNVHRMBAf8EBTADAQH/MBgGA1UdEQQRMA+CDXBy
b3ZpZGVyLnRlc3QwDQYJKoZIhvcNAQELBQADggEBAIqEzOJm4vRt2rka6XUiT0in
4gWQNbX0hzOruk7sbCrtCvZX4+MjB/DaV/exnLPweq+6TYoi7/KMIM/UXs+xRBqx
j66lPxCJ1c3viw0BgHSUJTMYfMOBzFNFkFsfNT9gRy0T9yZP7zDXwBTHyV8lCW2s
RfcV4hNEzmZ+XoPeEz2POnbVNdry/TU0a+v7Npz4HPgoSBXk25HhswI7dJbrwFAB
kQ9YQXUI7jB1AJ4jeR0HfuTA8/nDkN7HsSCgj2iV7pclvHTDh+tHvwFCPNUYswqS
o2KG3hIxo47tkb0axPivqwjm29GD0YWuI8mHlkGoCHWRvoFGTe0Nm+L1J1WRJ0M=
-----END CERTIFICATE-----`;
