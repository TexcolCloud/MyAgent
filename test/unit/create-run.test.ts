import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { SqliteCatalogRepository } from "../../src/adapters/sqlite/catalog-repository.js";
import { openDatabase, type SqliteDatabase } from "../../src/adapters/sqlite/database.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { SqliteRunRepository } from "../../src/adapters/sqlite/run-repository.js";
import {
  CreateRunService,
  type CreateRunCommand,
} from "../../src/application/create-run.js";
import { loadCatalog, type CatalogSnapshot } from "../../src/config/catalog-loader.js";
import type {
  AgentDefinitionRevision,
  AgentRevisionSnapshot,
} from "../../src/domain/agent-revision.js";
import {
  modelProfileRevisionIdFromUuid,
  providerConnectionRevisionIdFromUuid,
  runIdFromUuid,
  sessionIdFromUuid,
  type AgentId,
} from "../../src/domain/ids.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { FakeIds } from "../helpers/fake-ids.js";

describe("CreateRunService", () => {
  let catalogSnapshot: CatalogSnapshot;

  beforeAll(async () => {
    catalogSnapshot = await loadCatalog(
      path.resolve("test/fixtures/config/valid/myagent.yaml"),
    );
  });

  it("returns the original Run only for the same scoped request digest", () => {
    const harness = createHarness(catalogSnapshot, {
      sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000001")],
      runIds: [runIdFromUuid("00000000-0000-7000-8000-000000000001")],
    });
    try {
      const first = harness.service.execute(command());
      const retry = harness.service.execute(command());

      expect(retry).toEqual({ ...first, created: false });
      expect(() =>
        harness.service.execute(
          command({ input: { type: "text", text: "different" } }),
        ),
      ).toThrowError(expect.objectContaining({ code: "idempotency_conflict" }));
    } finally {
      harness.connection.close();
    }
  });

  it("allows two Agents to reuse one Session Key without sharing a Session", () => {
    const harness = createHarness(catalogSnapshot, {
      sessionIds: [
        sessionIdFromUuid("00000000-0000-7000-8000-000000000001"),
        sessionIdFromUuid("00000000-0000-7000-8000-000000000002"),
      ],
      runIds: [
        runIdFromUuid("00000000-0000-7000-8000-000000000001"),
        runIdFromUuid("00000000-0000-7000-8000-000000000002"),
      ],
    });
    try {
      const primary = harness.service.execute(command({ sessionKey: "shared:key" }));
      const researcher = harness.service.execute(
        command({ agentId: "researcher", sessionKey: "shared:key" }),
      );

      expect(primary.sessionId).not.toBe(researcher.sessionId);
    } finally {
      harness.connection.close();
    }
  });

  it("rolls back every created record when the Run insert fails", () => {
    const duplicateRunId = runIdFromUuid("00000000-0000-7000-8000-000000000001");
    const harness = createHarness(catalogSnapshot, {
      sessionIds: [sessionIdFromUuid("00000000-0000-7000-8000-000000000001")],
      runIds: [duplicateRunId, duplicateRunId],
    });
    try {
      harness.service.execute(command());

      expect(() =>
        harness.service.execute(
          command({
            input: { type: "text", text: "second" },
            idempotencyKey: "request-0002",
          }),
        ),
      ).toThrow();
      expect(count(harness.connection, "runs")).toBe(1);
      expect(count(harness.connection, "messages")).toBe(1);
      expect(count(harness.connection, "run_events")).toBe(1);
      expect(count(harness.connection, "idempotency_keys")).toBe(1);
    } finally {
      harness.connection.close();
    }
  });
});

interface Harness {
  connection: SqliteDatabase;
  service: CreateRunService;
}

function createHarness(
  snapshot: CatalogSnapshot,
  ids: ConstructorParameters<typeof FakeIds>[0],
): Harness {
  const connection = openDatabase({ path: ":memory:", busyTimeoutMs: 5_000 });
  migrate(connection.db);
  const catalogRepository = new SqliteCatalogRepository(connection.db);
  const runRepository = new SqliteRunRepository(connection.db, catalogRepository);
  const service = new CreateRunService(
    {
      resolve(agentId: AgentId) {
        const definition = snapshot.byId.get(agentId)?.definition;
        if (definition === undefined) throw new Error("agent_unavailable");
        return resolvedRevision(definition);
      },
    },
    runRepository,
    new FakeClock(new Date("2026-08-07T00:00:00.000Z")),
    new FakeIds(ids),
  );
  return { connection, service };
}

function resolvedRevision(
  definition: AgentDefinitionRevision,
): AgentRevisionSnapshot {
  return {
    ...definition,
    revisionId: `rev_${definition.agentId}`,
    definitionRevisionId: definition.definitionRevisionId,
    modelProfileRevisionId: modelProfileRevisionIdFromUuid(
      "00000000-0000-7000-8000-000000000001",
    ),
    model: {
      providerConnectionRevisionId: providerConnectionRevisionIdFromUuid(
        "00000000-0000-7000-8000-000000000001",
      ),
      providerKind: "openai_compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      providerAuth: {
        type: "bearer",
        secret: { fromEnvironment: "MODEL_API_KEY" },
      },
      modelId: "test-model",
      invocationProtocol: "chat_completions",
      maxInputTokens: 32_768,
      verifiedCapabilities: ["streaming_text", "single_tool_call"],
      compatibilityPresetVersion: "test-v1",
    },
    contentSha256: definition.contentSha256,
  };
}

function command(overrides: Partial<CreateRunCommand> = {}): CreateRunCommand {
  return {
    agentId: "primary",
    sessionKey: "cli:main",
    input: { type: "text", text: "hello" },
    idempotencyKey: "request-0001",
    source: { kind: "http" },
    ...overrides,
  };
}

function count(connection: SqliteDatabase, table: string): number {
  const row = connection.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}
