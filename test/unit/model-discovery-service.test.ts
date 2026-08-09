import { describe, expect, it } from "vitest";

import {
  DiscoverModelsService,
  manualModelEntryAllowed,
} from "../../src/application/discover-models.js";
import type { DiscoveryView } from "../../src/domain/model-registry.js";
import type { ProviderConnectionRevision, ProviderConnectionView } from "../../src/domain/provider-connection.js";
import type { IdGenerator } from "../../src/ports/id-generator.js";
import type { ModelDiscoveryPort } from "../../src/ports/model-discovery.js";
import type { ModelRegistryStore, RecordDiscoveryInput } from "../../src/ports/model-registry-store.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");

describe("DiscoverModelsService", () => {
  it("returns a fresh cache without calling the provider", async () => {
    const registry = new MemoryRegistry(view("fresh", [{ id: "cached" }], NOW));
    const discovery = new ScriptedDiscovery();
    const result = await service(registry, discovery).execute(command(), new AbortController().signal);

    expect(result.models).toEqual([{ id: "cached" }]);
    expect(discovery.calls).toBe(0);
    expect(registry.records).toHaveLength(0);
  });

  it.each(["empty", "unsupported"] as const)(
    "returns the authoritative terminal %s state without a provider call",
    async (state) => {
      const registry = new MemoryRegistry(view(state, [], NOW));
      const discovery = new ScriptedDiscovery();

      const result = await service(registry, discovery).execute(command(), new AbortController().signal);

      expect(result.state).toBe(state);
      expect(discovery.calls).toBe(0);
      expect(manualModelEntryAllowed(result)).toBe(true);
    },
  );

  it("refreshes a fresh cache, persists normalized models, and grants no inferred metadata", async () => {
    const registry = new MemoryRegistry(view("fresh", [{ id: "cached" }], NOW));
    const discovery = new ScriptedDiscovery({
      state: "fresh",
      models: [{ id: "live", owner: "team", createdAt: new Date(1_000) }],
      fetchedAt: NOW,
    });

    const result = await service(registry, discovery).execute(
      command({ refresh: true }),
      new AbortController().signal,
    );

    expect(result).toMatchObject({ state: "fresh", models: [{ id: "live", owner: "team" }] });
    expect(registry.records).toHaveLength(1);
    expect(JSON.stringify(registry.records[0])).not.toContain("capabil");
    expect(JSON.stringify(registry.records[0])).not.toContain("secret");
  });

  it("returns stale cache normally and retains it with a safe error after a forced refresh failure", async () => {
    const registry = new MemoryRegistry(view("stale", [{ id: "cached" }], NOW));
    const discovery = new ScriptedDiscovery(new Error("provider-body-secret"));
    const normal = await service(registry, discovery).execute(command(), new AbortController().signal);
    expect(normal.state).toBe("stale");
    expect(discovery.calls).toBe(0);

    const refreshed = await service(registry, discovery).execute(
      command({ refresh: true, traceId: "trace-refresh" }),
      new AbortController().signal,
    );
    expect(refreshed).toMatchObject({
      state: "stale",
      models: [{ id: "cached" }],
      refreshError: { code: "provider_unavailable", traceId: "trace-refresh" },
    });
    expect(JSON.stringify(refreshed)).not.toContain("provider-body-secret");
  });

  it("distinguishes successful empty discovery and endpoint absence for manual-entry eligibility", async () => {
    const emptyRegistry = new MemoryRegistry(view("unsupported", [], null));
    const empty = await service(emptyRegistry, new ScriptedDiscovery({ state: "fresh", models: [], fetchedAt: NOW }))
      .execute(command(), new AbortController().signal);
    expect(empty.state).toBe("empty");
    expect(manualModelEntryAllowed(empty)).toBe(true);

    const unsupportedRegistry = new MemoryRegistry(view("unsupported", [], null));
    const unsupported = await service(unsupportedRegistry, new ScriptedDiscovery({ state: "unsupported", models: [], fetchedAt: NOW }))
      .execute(command(), new AbortController().signal);
    expect(unsupported.state).toBe("unsupported");
    expect(manualModelEntryAllowed(unsupported)).toBe(true);
    expect(manualModelEntryAllowed(view("fresh", [{ id: "advertised" }], NOW))).toBe(false);
  });

  it("records a failed discovery without inventing unsupported evidence and forwards cancellation", async () => {
    const registry = new MemoryRegistry(view("unsupported", [], null));
    const error = Object.assign(new Error("provider-secret"), { code: "provider_auth_failed", status: 401 });
    const result = await service(registry, new ScriptedDiscovery(error)).execute(command(), new AbortController().signal);
    expect(result).toMatchObject({ state: "failed", refreshError: { code: "provider_auth_failed", status: 401 } });
    expect(result.state).not.toBe("unsupported");
    expect(JSON.stringify(result)).not.toContain("provider-secret");

    const controller = new AbortController();
    controller.abort();
    await expect(
      service(registry, new ScriptedDiscovery()).execute(command({ refresh: true }), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

function service(registry: MemoryRegistry, discovery: ScriptedDiscovery): DiscoverModelsService {
  return new DiscoverModelsService(registry, discovery, fakeIds(), {
    cacheSeconds: 600,
    timeoutMs: 10_000,
    maxItems: 1_000,
    maxResponseBytes: 2_097_152,
  });
}

function command(overrides: Partial<{ refresh: boolean; traceId: string }> = {}) {
  return {
    revisionId: "pcr-test" as ProviderConnectionRevision["revisionId"],
    refresh: false,
    traceId: "trace-test",
    now: NOW,
    ...overrides,
  };
}

function view(
  state: DiscoveryView["state"],
  models: DiscoveryView["models"],
  fetchedAt: Date | null,
): DiscoveryView {
  return {
    connectionRevisionId: "pcr-test" as ProviderConnectionRevision["revisionId"],
    state,
    models,
    fetchedAt,
    expiresAt: fetchedAt === null ? null : new Date(fetchedAt.getTime() + 600_000),
  };
}

class ScriptedDiscovery implements ModelDiscoveryPort {
  calls = 0;
  constructor(private readonly result?: Awaited<ReturnType<ModelDiscoveryPort["discover"]>> | Error) {}

  async discover(
    _connection: ProviderConnectionRevision,
    _limits: Parameters<ModelDiscoveryPort["discover"]>[1],
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<ModelDiscoveryPort["discover"]>>> {
    signal.throwIfAborted();
    this.calls += 1;
    if (this.result instanceof Error) throw this.result;
    return this.result ?? { state: "fresh", models: [], fetchedAt: NOW };
  }
}

class MemoryRegistry implements Pick<ModelRegistryStore, "getDiscoveredModels" | "listConnections" | "recordDiscovery"> {
  readonly records: RecordDiscoveryInput[] = [];
  private current: DiscoveryView;

  constructor(initial: DiscoveryView) {
    this.current = initial;
  }

  getDiscoveredModels(): DiscoveryView {
    return this.current;
  }

  listConnections(): readonly ProviderConnectionView[] {
    return [{
      connectionId: "provider-test" as ProviderConnectionRevision["connectionId"],
      displayName: "provider-test",
      providerKind: "openai",
      activeRevisionId: null,
      retiredAt: null,
      recordRevision: 0,
      revisions: [connection()],
    }];
  }

  recordDiscovery(input: RecordDiscoveryInput): DiscoveryView {
    this.records.push(input);
    if (input.state === "failed" && this.current.models.length > 0) {
      this.current = {
        ...this.current,
        state: "stale",
        refreshError: { code: input.error?.code ?? "provider_unavailable", traceId: input.traceId },
      };
      return this.current;
    }
    this.current = {
      connectionRevisionId: input.connectionRevisionId,
      state: input.state,
      models: input.models,
      fetchedAt: input.now,
      expiresAt: input.expiresAt ?? null,
      ...(input.error === undefined ? {} : { refreshError: { ...input.error, traceId: input.traceId } }),
    };
    return this.current;
  }
}

function connection(): ProviderConnectionRevision {
  return {
    revisionId: "pcr-test" as ProviderConnectionRevision["revisionId"],
    connectionId: "provider-test" as ProviderConnectionRevision["connectionId"],
    state: "draft",
    baseUrl: "https://provider.test/v1",
    auth: { type: "none" },
    allowInsecureHttp: false,
    protocolPreference: "responses",
    presetVersion: "test",
    createdAt: NOW,
  };
}

function fakeIds(): Pick<IdGenerator, "discoveryGenerationId" | "modelRegistryEventId"> {
  return {
    discoveryGenerationId: () => "dgn-test" as ReturnType<IdGenerator["discoveryGenerationId"]>,
    modelRegistryEventId: () => "mre-test" as ReturnType<IdGenerator["modelRegistryEventId"]>,
  };
}
