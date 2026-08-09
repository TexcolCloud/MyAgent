import { describe, expect, it } from "vitest";

import { openDatabase } from "../../src/adapters/sqlite/database.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { SqliteSessionRepository } from "../../src/adapters/sqlite/session-repository.js";
import { PromptAssembler } from "../../src/application/prompt-assembler.js";
import { SessionSummarizer } from "../../src/application/session-summarizer.js";
import type { AgentRevisionSnapshot } from "../../src/domain/agent-revision.js";
import {
  attemptIdFromUuid,
  modelProfileRevisionIdFromUuid,
  parseAgentId,
  providerConnectionRevisionIdFromUuid,
  runIdFromUuid,
  sessionIdFromUuid,
} from "../../src/domain/ids.js";
import { DEFAULT_RUN_LIMITS } from "../../src/domain/limits.js";
import { ModelProviderError } from "../../src/ports/model.js";
import type {
  SaveSessionSummaryInput,
  SessionMessage,
  SessionStore,
  SessionSummary,
} from "../../src/ports/session-store.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { completedText, ScriptedModel } from "../helpers/scripted-model.js";

describe("SessionSummarizer", () => {
  it("summarizes oldest canonical messages without rewriting them", async () => {
    const store = new MemorySessionStore([
      message(0, "old context ".repeat(1_200)),
      message(1, "more old context ".repeat(1_200)),
    ]);
    const model = new ScriptedModel();
    model.script(
      {
        chunks: [],
        error: new ModelProviderError({
          transient: true,
          code: "provider_overloaded",
          status: 503,
        }),
      },
      completedText("short session summary"),
    );
    const clock = new FakeClock();
    const assembler = new PromptAssembler(store);
    const summarizer = new SessionSummarizer({
      assembler,
      sessionStore: store,
      model,
      clock,
    });
    const originalMessages = store.messages.map((entry) => ({ ...entry }));

    const result = await summarizer.ensureWithinBudget(
      promptInput(revision(2_000)),
      new AbortController().signal,
    );

    expect(result.summarized).toBe(true);
    expect(result.modelAttempts).toBe(2);
    expect(result.modelTurnsUsed).toBe(1);
    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]).toMatchObject({ purpose: "session_summary", tools: [] });
    expect(store.currentSummary).toMatchObject({
      sourceMessageFrom: 0,
      sourceMessageTo: 1,
      content: "short session summary",
      modelProvider: "openai_compatible",
      modelName: "test-model",
    });
    expect(store.messages).toEqual(originalMessages);
    expect(result.request.input.find(
      (entry) => entry.type === "message" && entry.name === "session_history",
    ))
      .toBeUndefined();
    const summaryInput = result.request.input.find(
      (entry): entry is Extract<typeof entry, { type: "message" }> =>
        entry.type === "message" && entry.name === "session_summary",
    );
    expect(summaryInput?.content).toContain("short session summary");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(clock.now().getTime()).toBe(250);
  });

  it("persists a completed summary when the provider omits Usage", async () => {
    const store = new MemorySessionStore([
      message(0, "oversized context ".repeat(2_000)),
    ]);
    const model = new ScriptedModel();
    model.script({
      chunks: [
        { type: "text_delta", text: "summary without usage" },
        { type: "completed", finishReason: "completed" },
      ],
    });
    const summarizer = new SessionSummarizer({
      assembler: new PromptAssembler(store),
      sessionStore: store,
      model,
      clock: new FakeClock(),
    });

    const result = await summarizer.ensureWithinBudget(
      promptInput(revision(2_000)),
      new AbortController().signal,
    );

    expect(result.summarized).toBe(true);
    expect(result).not.toHaveProperty("usage");
    expect(store.currentSummary).toMatchObject({
      content: "summary without usage",
    });
  });

  it("stops after three transient provider attempts", async () => {
    const store = new MemorySessionStore([
      message(0, "oversized context ".repeat(2_000)),
    ]);
    const model = new ScriptedModel();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      model.script({
        chunks: [],
        error: new ModelProviderError({
          transient: true,
          code: "provider_overloaded",
          status: 503,
        }),
      });
    }
    const summarizer = new SessionSummarizer({
      assembler: new PromptAssembler(store),
      sessionStore: store,
      model,
      clock: new FakeClock(),
    });

    await expect(
      summarizer.ensureWithinBudget(
        promptInput(revision(2_000)),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "provider_overloaded" });
    expect(model.requests).toHaveLength(3);
    expect(store.currentSummary).toBeNull();
  });

  it("carries the existing summary into replacement compaction", async () => {
    const store = new MemorySessionStore([
      message(0, "already summarized context"),
      message(1, "new context ".repeat(2_000)),
    ]);
    store.currentSummary = {
      summaryId: "summary:prior",
      sessionId: sessionIdFromUuid("00000000-0000-7000-8000-000000000001"),
      sourceMessageFrom: 0,
      sourceMessageTo: 0,
      content: "prior durable summary",
      modelProvider: "openai-compatible",
      modelName: "test-model",
      createdAt: new Date(0),
    };
    const model = new ScriptedModel();
    model.script(completedText("replacement summary"));
    const summarizer = new SessionSummarizer({
      assembler: new PromptAssembler(store),
      sessionStore: store,
      model,
      clock: new FakeClock(),
    });

    await summarizer.ensureWithinBudget(
      promptInput(revision(2_000)),
      new AbortController().signal,
    );

    expect(model.requests[0]?.input.map((entry) =>
      entry.type === "message" ? entry.name : entry.type
    )).toEqual([
      "summary_instructions",
      "session_summary",
      "session_history",
    ]);
    const priorSummary = model.requests[0]?.input[1];
    expect(priorSummary?.type === "message" ? priorSummary.content : undefined).toContain(
      "prior durable summary",
    );
    expect(store.currentSummary).toMatchObject({
      sourceMessageFrom: 0,
      sourceMessageTo: 1,
      content: "replacement summary",
    });
  });

  it("does not advance a summary watermark across the current queued input", async () => {
    const input = promptInput(revision(2_000));
    const earlierRunId = runIdFromUuid(
      "00000000-0000-7000-8000-000000000010",
    );
    const store = new MemorySessionStore([
      message(0, "old context ".repeat(2_000), {
        runId: earlierRunId,
        runFifoSequence: 0,
      }),
      message(1, "current queued input must survive", {
        runId: input.runId,
        runFifoSequence: input.runFifoSequence,
      }),
      message(2, "late assistant output must survive", {
        runId: earlierRunId,
        runFifoSequence: 0,
        role: "assistant",
      }),
    ]);
    const model = new ScriptedModel();
    model.script(completedText("prefix summary"));
    const assembler = new PromptAssembler(store);
    const summarizer = new SessionSummarizer({
      assembler,
      sessionStore: store,
      model,
      clock: new FakeClock(),
    });

    await summarizer.ensureWithinBudget(
      input,
      new AbortController().signal,
    );

    expect(store.currentSummary).toMatchObject({
      sourceMessageFrom: 0,
      sourceMessageTo: 0,
    });
    const summarizedHistory = model.requests[0]?.input.find(
      (entry): entry is Extract<typeof entry, { type: "message" }> =>
        entry.type === "message" && entry.name === "session_history",
    );
    expect(summarizedHistory?.content).not.toContain(
      "late assistant output must survive",
    );

    const futureRequest = await assembler.build({
      ...input,
      runId: runIdFromUuid("00000000-0000-7000-8000-000000000100"),
      runFifoSequence: 100,
      input: { type: "text", text: "future input" },
    });
    const futureHistory = futureRequest.input.find(
      (entry): entry is Extract<typeof entry, { type: "message" }> =>
        entry.type === "message" && entry.name === "session_history",
    );
    expect(futureHistory?.content).toContain("current queued input must survive");
    expect(futureHistory?.content).toContain("late assistant output must survive");
  });
});

describe("SqliteSessionRepository summary attempt completion", () => {
  it.each([
    {
      label: "present",
      usage: { inputTokens: 20, outputTokens: 4 },
      expectedUsage: { inputTokens: 20, outputTokens: 4 },
    },
    { label: "absent", usage: undefined, expectedUsage: undefined },
  ])("persists Usage only when $label", ({ usage, expectedUsage }) => {
    const connection = openDatabase({ path: ":memory:", busyTimeoutMs: 5_000 });
    try {
      migrate(connection.db);
      const runId = runIdFromUuid("00000000-0000-7000-8000-000000000201");
      const sessionId = sessionIdFromUuid("00000000-0000-7000-8000-000000000201");
      seedLeasedRun(connection.db, runId, sessionId);
      const repository = new SqliteSessionRepository(connection.db);

      repository.saveSummaryWithLease({
        runId,
        leaseOwner: "worker-unit",
        attemptId: attemptIdFromUuid("00000000-0000-7000-8000-000000000201"),
        finishReason: "completed",
        ...(usage === undefined ? {} : { usage }),
        occurredAt: new Date("2026-08-09T00:00:01.000Z"),
        summary: {
          summaryId: "summary:usage",
          sessionId,
          sourceMessageFrom: 0,
          sourceMessageTo: 1,
          content: "durable summary",
          modelProvider: "openai_compatible",
          modelName: "test-model",
          createdAt: new Date("2026-08-09T00:00:01.000Z"),
        },
      });

      const row = connection.db.prepare(
        "SELECT payload_json FROM run_events WHERE event_type = 'message.completed'",
      ).get() as { payload_json: string };
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      expect(payload).toMatchObject({
        purpose: "session_summary",
        finishReason: "completed",
      });
      expect(payload.usage).toEqual(expectedUsage);
      expect(Object.hasOwn(payload, "usage")).toBe(usage !== undefined);
    } finally {
      connection.close();
    }
  });
});

class MemorySessionStore implements SessionStore {
  currentSummary: SessionSummary | null = null;

  constructor(readonly messages: SessionMessage[]) {}

  delete(): void {}

  getCurrentSummary(): SessionSummary | null {
    return this.currentSummary;
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
    this.currentSummary = { ...input };
    return this.currentSummary;
  }

  saveSummaryWithLease(
    input: Parameters<SessionStore["saveSummaryWithLease"]>[0],
  ): SessionSummary {
    return this.saveSummary(input.summary);
  }
}

function message(
  sequence: number,
  text: string,
  overrides: Partial<SessionMessage> = {},
): SessionMessage {
  return {
    messageId: `message:${String(sequence)}`,
    sessionId: sessionIdFromUuid("00000000-0000-7000-8000-000000000001"),
    runId: runIdFromUuid(
      `00000000-0000-7000-8000-${String(sequence + 10).padStart(12, "0")}`,
    ),
    sequence,
    runFifoSequence: sequence,
    role: "user",
    content: { type: "text", text },
    createdAt: new Date(sequence),
    ...overrides,
  };
}

function promptInput(revisionSnapshot: AgentRevisionSnapshot) {
  return {
    revision: revisionSnapshot,
    sessionId: sessionIdFromUuid("00000000-0000-7000-8000-000000000001"),
    runId: runIdFromUuid("00000000-0000-7000-8000-000000000099"),
    runFifoSequence: 99,
    input: { type: "text" as const, text: "current input" },
    activatedSkillNames: [] as const,
    toolResults: [] as const,
    tools: [] as const,
  };
}

function revision(maxInputTokens: number): AgentRevisionSnapshot {
  return {
    revisionId: "rev_summary",
    definitionRevisionId: "definition:primary:summary",
    agentId: parseAgentId("primary"),
    displayName: "Primary",
    prompt: "trusted agent instructions",
    modelProfileRevisionId: modelProfileRevisionIdFromUuid("summary-profile"),
    model: {
      providerConnectionRevisionId:
        providerConnectionRevisionIdFromUuid("summary-connection"),
      providerKind: "openai_compatible",
      baseUrl: "https://example.invalid/v1",
      providerAuth: {
        type: "bearer",
        secret: { fromEnvironment: "TEST_API_KEY" },
      },
      modelId: "test-model",
      invocationProtocol: "chat_completions",
      maxInputTokens,
      verifiedCapabilities: ["streaming_text", "single_tool_call"],
      compatibilityPresetVersion: "openai-chat-v1",
    },
    workspace: ".",
    skills: [],
    policy: [],
    delegates: [],
    limits: DEFAULT_RUN_LIMITS,
    contentSha256: "0".repeat(64),
  };
}

function seedLeasedRun(
  db: ReturnType<typeof openDatabase>["db"],
  runId: ReturnType<typeof runIdFromUuid>,
  sessionId: ReturnType<typeof sessionIdFromUuid>,
): void {
  const now = "2026-08-09T00:00:00.000Z";
  db.prepare(
    `INSERT INTO agent_revisions (
       revision_id, agent_id, content_json, content_sha256, created_at
     ) VALUES ('rev-summary-usage', 'primary', '{}', ?, ?)`,
  ).run("a".repeat(64), now);
  db.prepare(
    `INSERT INTO sessions (
       session_id, agent_id, session_key, agent_revision_id, created_at, updated_at
     ) VALUES (?, 'primary', 'summary:usage', 'rev-summary-usage', ?, ?)`,
  ).run(sessionId, now, now);
  db.prepare(
    `INSERT INTO runs (
       run_id, session_id, agent_revision_id, state, fifo_sequence,
       delegation_depth, lease_owner, lease_expires_at, active_started_at,
       request_digest, input_json, created_at, updated_at
     ) VALUES (?, ?, 'rev-summary-usage', 'running', 0, 0, 'worker-unit',
       '2026-08-09T00:01:00.000Z', ?, ?, '{"type":"text","text":"summarize"}', ?, ?)`,
  ).run(runId, sessionId, now, "b".repeat(64), now, now);
}
