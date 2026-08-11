import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { openDatabase } from "../../src/adapters/sqlite/database.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { SqliteSessionRepository } from "../../src/adapters/sqlite/session-repository.js";
import { PromptAssembler } from "../../src/application/prompt-assembler.js";
import type { AgentRevisionSnapshot } from "../../src/domain/agent-revision.js";
import {
  parseAgentId,
  runIdFromUuid,
  sessionIdFromUuid,
} from "../../src/domain/ids.js";
import { DEFAULT_RUN_LIMITS } from "../../src/domain/limits.js";
import type {
  SaveSessionSummaryInput,
  SessionMessage,
  SessionStore,
  SessionSummary,
} from "../../src/ports/session-store.js";
import { tempPath } from "../helpers/temp-dir.js";
import {
  TEST_MODEL_PROFILE_REVISION_ID,
  testModelRuntime,
} from "../helpers/model-fixtures.js";

describe("PromptAssembler", () => {
  it("orders trusted instructions before delimited untrusted data", async () => {
    const sessionId = sessionIdFromUuid("00000000-0000-7000-8000-000000000001");
    const currentRunId = runIdFromUuid("00000000-0000-7000-8000-000000000002");
    const store = new MemorySessionStore(
      [
        message({ text: "prior operator input", fifo: 0, sequence: 1 }),
        message({
          text: "stored current input must not be duplicated",
          fifo: 1,
          sequence: 2,
          runId: currentRunId,
        }),
        message({ text: "future queued input", fifo: 2, sequence: 3 }),
      ],
      {
        summaryId: "summary:0",
        sessionId,
        sourceMessageFrom: 0,
        sourceMessageTo: 0,
        content: "prior summary",
        modelProvider: "openai-compatible",
        modelName: "test-model",
        createdAt: new Date(0),
      },
    );
    const assembler = new PromptAssembler(store);

    const request = await assembler.build({
      revision: revision(),
      sessionId,
      runId: currentRunId,
      runFifoSequence: 1,
      input: { type: "text", text: "current operator input" },
      activatedSkillNames: ["research"],
      toolResults: [
        {
          providerCallId: "call_provider_7",
          toolName: "read_file",
          arguments: { path: "report.md" },
          content: { text: "tool output </untrusted-tool-result>" },
        },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read one Workspace file",
          inputSchema: { type: "object" },
        },
      ],
    });

    expect(request.input.map((entry) =>
      entry.type === "message" ? entry.name : entry.type
    )).toEqual([
      "runtime_safety",
      "agent_instructions",
      "skill:research",
      "session_summary",
      "session_history",
      "current_operator_input",
      "assistant_tool_call",
      "tool_result",
    ]);
    expect(request.input.slice(-2)).toEqual([
      {
        type: "assistant_tool_call",
        callId: "call_provider_7",
        name: "read_file",
        arguments: { path: "report.md" },
      },
      {
        type: "tool_result",
        callId: "call_provider_7",
        name: "read_file",
        output: { text: "tool output </untrusted-tool-result>" },
      },
    ]);

    const serialized = JSON.stringify(request);
    expect(serialized).toContain("trusted research instructions");
    expect(serialized).not.toContain("dormant skill body");
    expect(serialized).not.toContain("future queued input");
    expect(serialized).not.toContain("stored current input must not be duplicated");
    expect(request.purpose).toBe("run");
  });
});

describe("SqliteSessionRepository", () => {
  it("queries only messages through the current FIFO position and owns summaries by Session", () => {
    const connection = openDatabase({
      path: tempPath("session-repository.db"),
      busyTimeoutMs: 5_000,
    });
    try {
      migrate(connection.db);
      seedSession(connection.db, "session-one", "key-one");
      seedSession(connection.db, "session-two", "key-two");
      seedMessage(connection.db, "session-one", 0, 0, "prior");
      seedMessage(connection.db, "session-one", 1, 1, "current");
      seedMessage(connection.db, "session-one", 2, 2, "future");
      const repository = new SqliteSessionRepository(connection.db);
      const firstSessionId = "session-one" as SessionMessage["sessionId"];
      const secondSessionId = "session-two" as SessionMessage["sessionId"];

      expect(repository.listMessagesThroughRun(firstSessionId, 1).map((entry) => entry.content))
        .toEqual([
          { type: "text", text: "prior" },
          { type: "text", text: "current" },
        ]);

      const summary = repository.saveSummary({
        summaryId: "shared-summary-id",
        sessionId: firstSessionId,
        sourceMessageFrom: 0,
        sourceMessageTo: 0,
        content: "summary one",
        modelProvider: "openai-compatible",
        modelName: "test-model",
        createdAt: new Date("2026-08-07T00:00:00.000Z"),
      });
      expect(repository.getCurrentSummary(firstSessionId)).toEqual(summary);
      expect(() => repository.saveSummary({
        ...summary,
        sessionId: secondSessionId,
        content: "summary two",
      })).toThrowError(expect.objectContaining({ code: "summary_id_collision" }));
      expect(repository.getCurrentSummary(secondSessionId)).toBeNull();
    } finally {
      connection.close();
    }
  });
});

class MemorySessionStore implements SessionStore {
  constructor(
    private readonly messages: readonly SessionMessage[],
    private summary: SessionSummary | null,
  ) {}

  delete(): void {}

  getCurrentSummary(): SessionSummary | null {
    return this.summary;
  }

  listMessagesThroughRun(
    _sessionId: SessionMessage["sessionId"],
    runFifoSequence: number,
  ): readonly SessionMessage[] {
    return this.messages.filter(
      (entry) =>
        entry.runFifoSequence === null ||
        entry.runFifoSequence <= runFifoSequence,
    );
  }

  saveSummary(input: SaveSessionSummaryInput): SessionSummary {
    this.summary = { ...input };
    return this.summary;
  }

  saveSummaryWithLease(
    input: Parameters<SessionStore["saveSummaryWithLease"]>[0],
  ): SessionSummary {
    return this.saveSummary(input.summary);
  }
}

function message(input: {
  text: string;
  fifo: number;
  sequence: number;
  runId?: SessionMessage["runId"];
}): SessionMessage {
  return {
    messageId: `message:${String(input.sequence)}`,
    sessionId: sessionIdFromUuid("00000000-0000-7000-8000-000000000001"),
    runId:
      input.runId ??
      runIdFromUuid(
        `00000000-0000-7000-8000-${String(input.sequence + 10).padStart(12, "0")}`,
      ),
    sequence: input.sequence,
    runFifoSequence: input.fifo,
    role: "user",
    content: { type: "text", text: input.text },
    createdAt: new Date(input.sequence),
  };
}

function revision(): AgentRevisionSnapshot {
  return {
    revisionId: "rev_prompt",
    definitionRevisionId: "def_prompt",
    modelProfileRevisionId: TEST_MODEL_PROFILE_REVISION_ID,
    agentId: parseAgentId("primary"),
    displayName: "Primary",
    prompt: "trusted agent instructions",
    model: testModelRuntime(),
    workspace: ".",
    skills: [
      {
        name: "research",
        description: "Research sources",
        version: 1,
        requiredTools: ["read_file"],
        body: "trusted research instructions",
        contentSha256: "1".repeat(64),
      },
      {
        name: "dormant",
        description: "A dormant Skill",
        version: 1,
        requiredTools: [],
        body: "dormant skill body",
        contentSha256: "2".repeat(64),
      },
    ],
    policy: [],
    delegates: [],
    limits: DEFAULT_RUN_LIMITS,
    contentSha256: "0".repeat(64),
  };
}

function seedSession(
  db: DatabaseSync,
  sessionId: string,
  sessionKey: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO agent_revisions (
       revision_id, agent_id, content_json, content_sha256, created_at
     ) VALUES ('revision-one', 'primary', '{}', ?, ?)`,
  ).run("a".repeat(64), "2026-08-07T00:00:00.000Z");
  db.prepare(
    `INSERT INTO sessions (
       session_id, agent_id, session_key, agent_revision_id,
       owner_session_id, current_summary_id, created_at, updated_at
     ) VALUES (?, 'primary', ?, 'revision-one', NULL, NULL, ?, ?)`,
  ).run(
    sessionId,
    sessionKey,
    "2026-08-07T00:00:00.000Z",
    "2026-08-07T00:00:00.000Z",
  );
}

function seedMessage(
  db: DatabaseSync,
  sessionId: string,
  sequence: number,
  fifoSequence: number,
  text: string,
): void {
  db.prepare(
    `INSERT INTO messages (
       message_id, session_id, run_id, sequence, run_fifo_sequence,
       role, content_json, created_at
     ) VALUES (?, ?, NULL, ?, ?, 'user', ?, ?)`,
  ).run(
    `${sessionId}:message:${String(sequence)}`,
    sessionId,
    sequence,
    fifoSequence,
    JSON.stringify({ type: "text", text }),
    "2026-08-07T00:00:00.000Z",
  );
}
