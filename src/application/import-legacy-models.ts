import type { Clock } from "../ports/clock.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type {
  LegacyImportResult,
  LegacyModelImportSeed,
  ModelRegistryStore,
} from "../ports/model-registry-store.js";

type LegacyImportRegistry = Pick<ModelRegistryStore, "importLegacy">;

export class ImportLegacyModelsService {
  constructor(
    private readonly registry: LegacyImportRegistry,
    private readonly clock: Pick<Clock, "now">,
    private readonly ids: Pick<IdGenerator, "modelRegistryEventId">,
  ) {}

  execute(seed: LegacyModelImportSeed): LegacyImportResult {
    return this.registry.importLegacy({
      migrationVersion: 1,
      sourceSha256: seed.sourceSha256,
      models: Object.entries(seed.models)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([alias, model]) => ({ alias, ...model })),
      agentAliases: seed.agentAliases,
      eventId: this.ids.modelRegistryEventId(),
      traceId: "startup.legacy_import",
      now: this.clock.now(),
    });
  }
}
