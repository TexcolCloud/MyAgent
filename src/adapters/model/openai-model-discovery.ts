import OpenAI from "openai";

import type { ProviderConnectionRevision } from "../../domain/provider-connection.js";
import { ModelProviderError } from "../../ports/model.js";
import type {
  DiscoveryResult,
  ModelDiscoveryLimits,
  ModelDiscoveryPort,
} from "../../ports/model-discovery.js";
import type { ProviderHttpTransport } from "../../ports/provider-http-transport.js";

interface ModelsPageBody {
  readonly data: readonly unknown[];
  readonly has_more?: unknown;
  readonly last_id?: unknown;
}

export class OpenAiModelDiscovery implements ModelDiscoveryPort {
  constructor(private readonly transport: ProviderHttpTransport) {}

  async discover(
    connection: ProviderConnectionRevision,
    limits: ModelDiscoveryLimits,
    signal: AbortSignal,
  ): Promise<DiscoveryResult> {
    assertLimits(limits);
    if (signal.aborted) throw abortError();
    const client = new OpenAI({
      apiKey: "transport-owned-authentication",
      baseURL: connection.baseUrl,
      maxRetries: 0,
      fetch: this.transport.createFetch({
        connection,
        timeoutMs: limits.timeoutMs,
        maxResponseBytes: limits.maxResponseBytes,
      }),
    });
    const models: Array<{ id: string; owner?: string; createdAt?: Date }> = [];
    const identifiers = new Set<string>();
    const cursors = new Set<string>();
    let after: string | undefined;
    let pages = 0;

    try {
      for (;;) {
        if (signal.aborted) throw abortError();
        const page = await client.models.list({
          signal,
          ...(after === undefined ? {} : { query: { after } }),
        });
        pages += 1;
        const body = pageBody(page);
        for (const item of body.data) {
          const model = normalizeModel(item);
          if (identifiers.has(model.id) || models.length >= limits.maxItems) {
            throw protocolError();
          }
          identifiers.add(model.id);
          models.push(model);
        }
        if (body.has_more !== true) break;
        if (pages >= limits.maxItems || models.length >= limits.maxItems) {
          throw protocolError();
        }
        const cursor = body.last_id;
        if (typeof cursor !== "string" || cursor.length === 0 || cursors.has(cursor)) {
          throw protocolError();
        }
        cursors.add(cursor);
        after = cursor;
      }
    } catch (error) {
      if (signal.aborted) throw abortError();
      const providerError = findProviderError(error);
      if (isClearEndpointAbsence(providerError)) {
        return { state: "unsupported", models: [], fetchedAt: new Date() };
      }
      throw providerError ?? new ModelProviderError({
        code: "provider_unavailable",
        transient: true,
      });
    }

    return {
      state: models.length === 0 ? "empty" : "fresh",
      models,
      fetchedAt: new Date(),
    };
  }
}

function assertLimits(limits: ModelDiscoveryLimits): void {
  if (
    !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs <= 0 ||
    !Number.isSafeInteger(limits.maxItems) || limits.maxItems <= 0 ||
    !Number.isSafeInteger(limits.maxResponseBytes) || limits.maxResponseBytes < 0
  ) {
    throw protocolError();
  }
}

function pageBody(page: unknown): ModelsPageBody {
  const body = (page as { body?: unknown }).body;
  if (!isPageBody(body)) throw protocolError();
  return body;
}

function isPageBody(value: unknown): value is ModelsPageBody {
  return typeof value === "object" && value !== null &&
    Array.isArray((value as { data?: unknown }).data);
}

function normalizeModel(value: unknown): { id: string; owner?: string; createdAt?: Date } {
  if (typeof value !== "object" || value === null) throw protocolError();
  const item = value as { id?: unknown; owned_by?: unknown; created?: unknown };
  if (typeof item.id !== "string" || item.id.length === 0) throw protocolError();
  if (item.owned_by !== undefined && typeof item.owned_by !== "string") throw protocolError();
  const created = item.created;
  if (
    created !== undefined &&
    (typeof created !== "number" || !Number.isSafeInteger(created) || created < 0)
  ) {
    throw protocolError();
  }
  return {
    id: item.id,
    ...(item.owned_by === undefined ? {} : { owner: item.owned_by }),
    ...(created === undefined ? {} : { createdAt: new Date(created * 1_000) }),
  };
}

function isClearEndpointAbsence(error: ModelProviderError | undefined): boolean {
  return error?.code === "model_protocol_error" &&
    (error.status === 404 || error.status === 405 || error.status === 501);
}

function findProviderError(error: unknown): ModelProviderError | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    if (current instanceof ModelProviderError) return current;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function protocolError(): ModelProviderError {
  return new ModelProviderError({
    code: "model_protocol_error",
    transient: false,
  });
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}
