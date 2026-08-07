import { describe, expect, it } from "vitest";

import { PromptAssembler } from "../../src/application/prompt-assembler.js";
import { SessionSummarizer } from "../../src/application/session-summarizer.js";
import type { AgentRevisionSnapshot } from "../../src/domain/agent-revision.js";
import {
  parseAgentId,
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
      modelProvider: "openai-compatible",
      modelName: "test-model",
    });
    expect(store.messages).toEqual(originalMessages);
    expect(result.request.messages.find((entry) => entry.name === "session_history"))
      .toBeUndefined();
    expect(result.request.messages.find((entry) => entry.name === "session_summary")?.content)
      .toContain("short session summary");
    expect(clock.now().getTime()).toBe(250);
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

    expect(model.requests[0]?.messages.map((entry) => entry.name)).toEqual([
      "summary_instructions",
      "session_summary",
      "session_history",
    ]);
    expect(model.requests[0]?.messages[1]?.content).toContain(
      "prior durable summary",
    );
    expect(store.currentSummary).toMatchObject({
      sourceMessageFrom: 0,
      sourceMessageTo: 1,
      content: "replacement summary",
    });
  });
});

class MemorySessionStore implements SessionStore {
  currentSummary: SessionSummary | null = null;

  constructor(readonly messages: SessionMessage[]) {}

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
}

function message(sequence: number, text: string): SessionMessage {
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
    agentId: parseAgentId("primary"),
    displayName: "Primary",
    prompt: "trusted agent instructions",
    model: {
      provider: "openai-compatible",
      model: "test-model",
      baseUrl: "https://example.invalid/v1",
      apiKey: { fromEnvironment: "TEST_API_KEY" },
      maxInputTokens,
    },
    workspace: ".",
    skills: [],
    policy: [],
    delegates: [],
    limits: DEFAULT_RUN_LIMITS,
    contentSha256: "0".repeat(64),
  };
}
