import { PROVIDER_RUNTIME_ERROR_CODES } from "../domain/errors.js";
import type { ProviderConnectionRevision } from "../domain/provider-connection.js";
import type { DiscoveryView } from "../domain/model-registry.js";
import type { IdGenerator } from "../ports/id-generator.js";
import { ModelProviderError } from "../ports/model.js";
import type {
  DiscoveryResult,
  ModelDiscoveryLimits,
  ModelDiscoveryPort,
} from "../ports/model-discovery.js";
import type { ModelRegistryStore, RecordDiscoveryInput } from "../ports/model-registry-store.js";

export interface DiscoverModelsCommand {
  readonly revisionId: ProviderConnectionRevision["revisionId"];
  readonly refresh: boolean;
  readonly traceId: string;
  readonly now: Date;
}

export interface DiscoverModelsOptions extends ModelDiscoveryLimits {
  readonly cacheSeconds: number;
}

export class DiscoverModelsService {
  constructor(
    private readonly registry: Pick<
      ModelRegistryStore,
      "getDiscoveredModels" | "listConnections" | "recordDiscovery"
    >,
    private readonly discovery: ModelDiscoveryPort,
    private readonly ids: Pick<IdGenerator, "discoveryGenerationId" | "modelRegistryEventId">,
    private readonly options: DiscoverModelsOptions,
  ) {
    assertOptions(options);
  }

  async execute(
    command: DiscoverModelsCommand,
    signal: AbortSignal,
  ): Promise<DiscoveryView> {
    if (signal.aborted) throw abortError();
    const cached = this.registry.getDiscoveredModels(command.revisionId, command.now);
    if (!command.refresh && shouldReturnCached(cached)) return cached;

    const connection = findConnectionRevision(this.registry, command.revisionId);
    let result: DiscoveryResult;
    try {
      result = await this.discovery.discover(connection.revision, this.options, signal);
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw abortError();
      return this.registry.recordDiscovery({
        connectionRevisionId: command.revisionId,
        generationId: this.ids.discoveryGenerationId(),
        expectedRevision: connection.recordRevision,
        state: "failed",
        models: [],
        error: safeError(error),
        eventId: this.ids.modelRegistryEventId(),
        traceId: command.traceId,
        now: command.now,
      });
    }
    const state = result.state === "fresh" && result.models.length === 0
      ? "empty"
      : result.state;
    return this.registry.recordDiscovery({
      connectionRevisionId: command.revisionId,
      generationId: this.ids.discoveryGenerationId(),
      expectedRevision: connection.recordRevision,
      state,
      models: result.models,
      ...(state === "fresh"
        ? { expiresAt: new Date(command.now.getTime() + this.options.cacheSeconds * 1_000) }
        : {}),
      eventId: this.ids.modelRegistryEventId(),
      traceId: command.traceId,
      now: command.now,
    });
  }
}

interface ConnectionTarget {
  readonly revision: ProviderConnectionRevision;
  readonly recordRevision: number;
}

function shouldReturnCached(view: DiscoveryView): boolean {
  if (view.fetchedAt === null) return false;
  return view.state === "fresh" || view.state === "stale" ||
    view.state === "empty" || view.state === "unsupported";
}

function findConnectionRevision(
  registry: Pick<ModelRegistryStore, "listConnections">,
  revisionId: ProviderConnectionRevision["revisionId"],
): ConnectionTarget {
  for (const connection of registry.listConnections()) {
    const revision = connection.revisions.find((candidate) => candidate.revisionId === revisionId);
    if (revision !== undefined) {
      return { revision, recordRevision: connection.recordRevision };
    }
  }
  throw new Error("provider_connection_revision_not_found");
}

function safeError(error: unknown): NonNullable<RecordDiscoveryInput["error"]> {
  const providerError = findProviderError(error);
  if (providerError === undefined) return { code: "provider_unavailable" };
  const code = PROVIDER_RUNTIME_ERROR_CODES.includes(
    providerError.code as typeof PROVIDER_RUNTIME_ERROR_CODES[number],
  )
    ? providerError.code
    : "provider_unavailable";
  const status = typeof providerError.status === "number" && Number.isSafeInteger(providerError.status) &&
    providerError.status >= 400 && providerError.status <= 599
    ? providerError.status
    : undefined;
  return { code, ...(status === undefined ? {} : { status }) };
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

function assertOptions(options: DiscoverModelsOptions): void {
  if (!Number.isSafeInteger(options.cacheSeconds) || options.cacheSeconds <= 0) {
    throw new Error("invalid_discovery_options");
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

export function manualModelEntryAllowed(view: DiscoveryView): boolean {
  return view.fetchedAt !== null && (view.state === "empty" || view.state === "unsupported");
}
