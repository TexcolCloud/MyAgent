import { describe, expect, it, vi } from "vitest";

import { ImportLegacyModelsService } from "../../src/application/import-legacy-models.js";
import type { ModelRegistryEventId } from "../../src/domain/ids.js";
import type {
  LegacyImportRecord,
  LegacyImportResult,
  LegacyModelImportSeed,
} from "../../src/ports/model-registry-store.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { FakeIds } from "../helpers/fake-ids.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");

describe("ImportLegacyModelsService", () => {
  it("maps the validated seed to one atomic import in lexical alias order", () => {
    const expected: LegacyImportResult = {
      sourceSha256: "a".repeat(64),
      aliases: {},
      assignments: [],
      created: true,
    };
    const importLegacy = vi.fn<(input: LegacyImportRecord) => LegacyImportResult>(
      () => expected,
    );
    const service = new ImportLegacyModelsService(
      { importLegacy },
      new FakeClock(NOW),
      new FakeIds({
        modelRegistryEventIds: ["mre_legacy" as ModelRegistryEventId],
      }),
    );
    const seed: LegacyModelImportSeed = {
      sourceSha256: "a".repeat(64),
      models: {
        zeta: {
          providerKind: "openai_compatible",
          baseUrl: "https://zeta.example/v1",
          apiKey: { fromEnvironment: "ZETA_API_KEY" },
          modelId: "zeta-model",
          maxInputTokens: 8_192,
        },
        alpha: {
          providerKind: "openai",
          baseUrl: "https://api.openai.com/v1",
          apiKey: { fromEnvironment: "OPENAI_API_KEY" },
          modelId: "gpt-test",
          maxInputTokens: 32_768,
        },
      },
      agentAliases: { researcher: "zeta", primary: "alpha" },
    };

    expect(service.execute(seed)).toBe(expected);
    expect(importLegacy).toHaveBeenCalledWith({
      migrationVersion: 1,
      sourceSha256: "a".repeat(64),
      models: [
        { alias: "alpha", ...seed.models.alpha },
        { alias: "zeta", ...seed.models.zeta },
      ],
      agentAliases: seed.agentAliases,
      eventId: "mre_legacy",
      traceId: "startup.legacy_import",
      now: NOW,
    });
  });
});
