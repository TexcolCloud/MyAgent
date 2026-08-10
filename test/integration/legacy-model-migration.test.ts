import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { openDatabase } from "../../src/adapters/sqlite/database.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { SqliteModelRegistryRepository } from "../../src/adapters/sqlite/model-registry-repository.js";
import { ImportLegacyModelsService } from "../../src/application/import-legacy-models.js";
import type { ModelRegistryEventId } from "../../src/domain/ids.js";
import type {
  LegacyImportResult,
  LegacyModelImportSeed,
} from "../../src/ports/model-registry-store.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { FakeIds } from "../helpers/fake-ids.js";
import { tempPath } from "../helpers/temp-dir.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");

describe("legacy model migration", () => {
  it("imports one unshared Legacy-Trusted pair per alias exactly once", () => {
    usingFixture("legacy-model-import", ({ db, repository }) => {
      const service = importer(repository, ["mre_first", "mre_retry"]);

      const first = service.execute(SEED);
      const retry = service.execute(SEED);

      expect(retry).toEqual(first);
      expect(first.created).toBe(true);
      expect(Object.keys(first.aliases)).toEqual(["alpha", "beta"]);
      expect(new Set(Object.values(first.aliases).map(({ connectionId }) => connectionId)).size)
        .toBe(2);
      expect(new Set(Object.values(first.aliases).map(({ profileId }) => profileId)).size)
        .toBe(2);
      expect(tableCount(db, "provider_connections")).toBe(2);
      expect(tableCount(db, "provider_connection_revisions")).toBe(2);
      expect(tableCount(db, "model_profiles")).toBe(2);
      expect(tableCount(db, "model_profile_revisions")).toBe(2);
      expect(tableCount(db, "model_assignments")).toBe(2);
      expect(tableCount(db, "legacy_model_imports")).toBe(1);
      expect(tableCount(db, "model_registry_events")).toBe(1);

      const alpha = requiredAlias(first, "alpha");
      const beta = requiredAlias(first, "beta");
      const alphaConnection = repository.getConnection(alpha.connectionId);
      const alphaProfile = repository.getProfile(alpha.profileId);
      expect(alphaConnection).toMatchObject({
        displayName: "alpha",
        providerKind: "openai",
        activeRevisionId: alphaConnection.revisions[0]?.revisionId,
        recordRevision: 0,
      });
      expect(alphaConnection.revisions).toEqual([
        expect.objectContaining({
          state: "legacy_trusted",
          baseUrl: "https://api.openai.com/v1",
          auth: {
            type: "bearer",
            secret: { fromEnvironment: "OPENAI_API_KEY" },
          },
          protocolPreference: "chat_completions",
        }),
      ]);
      expect(alphaProfile).toMatchObject({
        displayName: "alpha",
        activeRevisionId: alpha.revisionId,
        recordRevision: 0,
      });
      expect(alphaProfile.revisions).toEqual([
        expect.objectContaining({
          revisionId: alpha.revisionId,
          state: "legacy_trusted",
          providerModelId: "gpt-test",
          invocationProtocol: "chat_completions",
          maxInputTokens: 32_768,
          contextWindowSource: "operator",
          verifiedCapabilities: [],
        }),
      ]);
      expect(first.assignments).toEqual([
        expect.objectContaining({
          agentId: "primary",
          modelProfileRevisionId: alpha.revisionId,
          source: "legacy_import",
          recordRevision: 0,
        }),
        expect.objectContaining({
          agentId: "researcher",
          modelProfileRevisionId: beta.revisionId,
          source: "legacy_import",
          recordRevision: 0,
        }),
      ]);

      const marker = db.prepare(
        "SELECT migration_version, source_sha256, result_json FROM legacy_model_imports",
      ).get() as { migration_version: number; source_sha256: string; result_json: string };
      expect(marker).toMatchObject({
        migration_version: 1,
        source_sha256: SEED.sourceSha256,
      });
      expect(JSON.parse(marker.result_json)).toMatchObject({
        sourceSha256: SEED.sourceSha256,
        aliases: first.aliases,
        created: true,
      });
      const audit = db.prepare(
        "SELECT payload_json FROM model_registry_events",
      ).get() as { payload_json: string };
      expect(audit.payload_json).not.toContain("API_KEY");
      expect(audit.payload_json).not.toContain("fromEnvironment");
    });
  });

  it("rejects a changed v1 source without overwriting the completed import", () => {
    usingFixture("legacy-model-changed", ({ db, repository }) => {
      const service = importer(repository, ["mre_first", "mre_changed"]);
      const first = service.execute(SEED);
      const before = registryCounts(db);

      expect(() => service.execute({
        ...SEED,
        sourceSha256: "2".repeat(64),
      })).toThrowError(expect.objectContaining({ code: "legacy_import_already_completed" }));

      expect(registryCounts(db)).toEqual(before);
      expect(repository.getConnection(
        requiredAlias(first, "alpha").connectionId,
      ).displayName).toBe("alpha");
    });
  });

  it("rejects an initial import when the Registry already contains state", () => {
    usingFixture("legacy-model-non-empty", ({ db, repository }) => {
      db.prepare(
        `INSERT INTO provider_connections (
           connection_id, display_name, provider_kind, active_revision_id,
           retired_at, record_revision, created_at, updated_at
         ) VALUES ('existing', 'Existing', 'openai', NULL, NULL, 0, ?, ?)`,
      ).run(NOW.toISOString(), NOW.toISOString());
      const before = registryCounts(db);

      expect(() => importer(repository, ["mre_non_empty"]).execute(SEED))
        .toThrowError(expect.objectContaining({
          code: "legacy_import_already_completed",
        }));

      expect(registryCounts(db)).toEqual(before);
    });
  });

  it("rolls back every inserted row when marker persistence fails", () => {
    usingFixture("legacy-model-rollback", ({ db, repository }) => {
      const service = importer(repository, ["mre_invalid"]);
      db.exec(
        `CREATE TRIGGER fail_legacy_import_marker
         BEFORE INSERT ON legacy_model_imports
         BEGIN
           SELECT RAISE(ABORT, 'late_legacy_import_failure');
         END`,
      );

      expect(() => service.execute(SEED)).toThrow("late_legacy_import_failure");

      expect(registryCounts(db)).toEqual({
        connections: 0,
        connectionRevisions: 0,
        profiles: 0,
        profileRevisions: 0,
        assignments: 0,
        markers: 0,
        events: 0,
      });
    });
  });
});

const SEED: LegacyModelImportSeed = {
  sourceSha256: "1".repeat(64),
  models: {
    beta: {
      providerKind: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKey: { fromEnvironment: "DEEPSEEK_API_KEY" },
      modelId: "deepseek-test",
      maxInputTokens: 65_536,
    },
    alpha: {
      providerKind: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: { fromEnvironment: "OPENAI_API_KEY" },
      modelId: "gpt-test",
      maxInputTokens: 32_768,
    },
  },
  agentAliases: { researcher: "beta", primary: "alpha" },
};

function importer(
  repository: SqliteModelRegistryRepository,
  eventIds: readonly string[],
): ImportLegacyModelsService {
  return new ImportLegacyModelsService(
    repository,
    new FakeClock(NOW),
    new FakeIds({
      modelRegistryEventIds: eventIds.map((id) => id as ModelRegistryEventId),
    }),
  );
}

function usingFixture(
  name: string,
  run: (fixture: {
    db: DatabaseSync;
    repository: SqliteModelRegistryRepository;
  }) => void,
): void {
  const connection = openDatabase({
    path: tempPath(`${name}.db`),
    busyTimeoutMs: 5_000,
  });
  try {
    migrate(connection.db);
    run({
      db: connection.db,
      repository: new SqliteModelRegistryRepository(connection.db),
    });
  } finally {
    connection.close();
  }
}

function tableCount(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function registryCounts(db: DatabaseSync): Record<string, number> {
  return {
    connections: tableCount(db, "provider_connections"),
    connectionRevisions: tableCount(db, "provider_connection_revisions"),
    profiles: tableCount(db, "model_profiles"),
    profileRevisions: tableCount(db, "model_profile_revisions"),
    assignments: tableCount(db, "model_assignments"),
    markers: tableCount(db, "legacy_model_imports"),
    events: tableCount(db, "model_registry_events"),
  };
}

function requiredAlias(
  result: LegacyImportResult,
  alias: string,
): LegacyImportResult["aliases"][string] {
  const value = result.aliases[alias];
  if (value === undefined) throw new Error(`missing imported alias: ${alias}`);
  return value;
}
