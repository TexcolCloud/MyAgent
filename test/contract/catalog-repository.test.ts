import { describe, expect, it } from "vitest";

import { SqliteCatalogRepository } from "../../src/adapters/sqlite/catalog-repository.js";
import { openDatabase } from "../../src/adapters/sqlite/database.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import type { AgentRevisionSnapshot } from "../../src/domain/agent-revision.js";
import { parseAgentId } from "../../src/domain/ids.js";
import { tempPath } from "../helpers/temp-dir.js";

describe("SqliteCatalogRepository", () => {
  it("stores complete Skill bodies without resolving model secrets", () => {
    const connection = openDatabase({
      path: tempPath("catalog-repository.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const repository = new SqliteCatalogRepository(connection.db);
      const revision = agentRevisionFixture();

      repository.save(revision);

      expect(repository.get(revision.revisionId)).toEqual(revision);
      expect(JSON.stringify(repository.get(revision.revisionId))).not.toContain("real-api-key");
    } finally {
      connection.close();
    }
  });

  it("keeps an identical revision save idempotent", () => {
    const connection = openDatabase({
      path: tempPath("catalog-idempotency.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const repository = new SqliteCatalogRepository(connection.db);
      const revision = agentRevisionFixture();

      repository.save(revision);
      repository.save(revision);

      expect(connection.db.prepare("SELECT COUNT(*) AS count FROM agent_revisions").get())
        .toEqual({ count: 1 });
    } finally {
      connection.close();
    }
  });

  it("rejects a revision ID collision without replacing stored content", () => {
    const connection = openDatabase({
      path: tempPath("catalog-collision.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      const repository = new SqliteCatalogRepository(connection.db);
      const revision = agentRevisionFixture();
      repository.save(revision);

      expect(() => repository.save({ ...revision, prompt: "Different prompt." }))
        .toThrowError(expect.objectContaining({ code: "revision_hash_collision" }));
      expect(repository.get(revision.revisionId)).toEqual(revision);
    } finally {
      connection.close();
    }
  });
});

function agentRevisionFixture(): AgentRevisionSnapshot {
  return {
    revisionId: "rev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    agentId: parseAgentId("primary"),
    displayName: "Primary",
    prompt: "Use the available tools carefully.",
    model: {
      provider: "openai",
      model: "gpt-5",
      baseUrl: "https://api.example.test/v1",
      apiKey: { fromEnvironment: "MODEL_API_KEY" },
      maxInputTokens: 32_000,
    },
    workspace: "D:/workspace",
    skills: [
      {
        name: "research",
        description: "Search local sources.",
        version: 1,
        requiredTools: ["read_file"],
        body: "Read every provided source before answering.\n",
        contentSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    ],
    policy: [{ tool: "read_file", effect: "allow" }],
    delegates: [parseAgentId("researcher")],
    limits: {
      modelTurns: 20,
      toolCalls: 12,
      childRuns: 4,
      delegationDepth: 1,
      activeExecutionSeconds: 900,
      defaultToolTimeoutMs: 120_000,
      maxToolTimeoutMs: 600_000,
      maxToolOutputBytes: 1_048_576,
      maxRunToolOutputBytes: 8_388_608,
    },
    contentSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
}
