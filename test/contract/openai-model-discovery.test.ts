import { afterEach, describe, expect, it } from "vitest";

import { OpenAiModelDiscovery } from "../../src/adapters/model/openai-model-discovery.js";
import { NodeProviderHttpTransport } from "../../src/adapters/provider-http-transport.js";
import type { ProviderConnectionRevision } from "../../src/domain/provider-connection.js";
import type { ProviderHttpTransport } from "../../src/ports/provider-http-transport.js";
import { FakeOpenAiProvider } from "../helpers/fake-openai-provider.js";

const providers: FakeOpenAiProvider[] = [];

describe("OpenAiModelDiscovery", () => {
  afterEach(async () => {
    await Promise.all(providers.splice(0).map((provider) => provider.close()));
  });

  it("follows Models cursors and returns only normalized fields", async () => {
    const provider = await startProvider();
    provider.modelsPages([
      {
        data: [{ id: "a", owned_by: "team", created: 1, secret: "raw-provider-payload" }],
        has_more: true,
        last_id: "a",
      },
      { data: [{ id: "b", secret: "raw-provider-payload" }] },
    ]);

    const result = await adapter().discover(
      connection(provider.baseUrl),
      limits(),
      new AbortController().signal,
    );

    expect(result).toEqual({
      state: "fresh",
      models: [
        { id: "a", owner: "team", createdAt: new Date(1_000) },
        { id: "b" },
      ],
      fetchedAt: expect.any(Date),
    });
    expect(provider.requests).toEqual([
      { path: "/v1/models" },
      { path: "/v1/models", after: "a" },
    ]);
    expect(JSON.stringify(result)).not.toContain("raw-provider-payload");
  });

  it.each([
    {
      name: "a duplicate identifier",
      pages: [
        { data: [{ id: "a" }], has_more: true, last_id: "a" },
        { data: [{ id: "a" }] },
      ],
    },
    {
      name: "a repeated cursor",
      pages: [
        { data: [{ id: "a" }], has_more: true, last_id: "a" },
        { data: [{ id: "b" }], has_more: true, last_id: "a" },
      ],
    },
  ])("rejects $name as a protocol error", async ({ pages }) => {
    const provider = await startProvider();
    provider.modelsPages(pages);

    await expect(
      adapter().discover(connection(provider.baseUrl), limits(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "model_protocol_error", transient: false });
  });

  it("enforces the item bound before accepting an oversized enumeration", async () => {
    const provider = await startProvider();
    provider.modelsPages([{ data: [{ id: "a" }, { id: "b" }] }]);

    await expect(
      adapter().discover(connection(provider.baseUrl), { ...limits(), maxItems: 1 }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "model_protocol_error", transient: false });
  });

  it("caps non-progressing page chains even when they contain no model identifiers", async () => {
    const provider = await startProvider();
    provider.modelsPages([
      { data: [], has_more: true, last_id: "first" },
      { data: [], has_more: true, last_id: "second" },
    ]);

    await expect(
      adapter().discover(connection(provider.baseUrl), { ...limits(), maxItems: 1 }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "model_protocol_error", transient: false });
  });

  it("uses the shared transport response-byte and timeout limits", async () => {
    const provider = await startProvider();
    provider.modelsPages([{ data: [{ id: "a".repeat(128) }] }]);
    await expect(
      adapter().discover(connection(provider.baseUrl), { ...limits(), maxResponseBytes: 32 }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "model_protocol_error" });

    provider.modelsPages([{ data: [{ id: "a" }] }]);
    provider.delayResponses(50);
    await expect(
      adapter().discover(connection(provider.baseUrl), { ...limits(), timeoutMs: 1 }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("preserves cancellation and exposes no provider response body", async () => {
    const provider = await startProvider();
    provider.modelsFailure({ status: 400, body: { error: { message: "provider-body-secret" } } });
    const failure = await adapter().discover(
      connection(provider.baseUrl),
      limits(),
      new AbortController().signal,
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "model_protocol_error", status: 400 });
    expect(String(failure)).not.toContain("provider-body-secret");

    provider.delayResponses(50);
    const controller = new AbortController();
    controller.abort("abort-secret");
    await expect(
      adapter().discover(connection(provider.baseUrl), limits(), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each([404, 405, 501])("classifies endpoint absence %i as unsupported", async (status) => {
    const provider = await startProvider();
    provider.modelsFailure({ status, body: { error: { message: "provider-body-secret" } } });

    await expect(
      adapter().discover(connection(provider.baseUrl), limits(), new AbortController().signal),
    ).resolves.toMatchObject({ state: "unsupported", models: [] });
  });
});

function adapter(): OpenAiModelDiscovery {
  const transport = new NodeProviderHttpTransport({
    secretResolver: { resolve: () => "not-used" },
  });
  return new OpenAiModelDiscovery(transport as ProviderHttpTransport);
}

function limits() {
  return { timeoutMs: 200, maxItems: 1_000, maxResponseBytes: 2_097_152 };
}

function connection(baseUrl: string): ProviderConnectionRevision {
  return {
    revisionId: "pcr-test" as ProviderConnectionRevision["revisionId"],
    connectionId: "provider-test" as ProviderConnectionRevision["connectionId"],
    state: "draft",
    baseUrl,
    auth: { type: "none" },
    allowInsecureHttp: true,
    protocolPreference: "responses",
    presetVersion: "test",
    createdAt: new Date(0),
  };
}

async function startProvider(): Promise<FakeOpenAiProvider> {
  const provider = await FakeOpenAiProvider.start();
  providers.push(provider);
  return provider;
}
