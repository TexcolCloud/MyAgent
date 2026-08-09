import { createHash } from "node:crypto";

import { z } from "zod";
import { beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../src/adapters/sqlite/database.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { SqliteToolRepository } from "../../src/adapters/sqlite/tool-repository.js";
import { ToolRegistry } from "../../src/adapters/tools/registry.js";
import {
  normalizeToolProposal,
  type NormalizeToolProposalInput,
} from "../../src/application/tool-proposal.js";
import { completedToolResults } from "../../src/application/prompt-assembler.js";
import type { AgentRevisionSnapshot } from "../../src/domain/agent-revision.js";
import {
  parseAgentId,
  runIdFromUuid,
  sessionIdFromUuid,
  toolCallIdFromUuid,
} from "../../src/domain/ids.js";
import type { JsonValue } from "../../src/domain/json.js";
import { DEFAULT_RUN_LIMITS } from "../../src/domain/limits.js";
import type { ToolCall } from "../../src/domain/tool-call.js";
import type { ToolDefinition } from "../../src/ports/tool.js";
import {
  TEST_MODEL_PROFILE_REVISION_ID,
  testModelRuntime,
} from "../helpers/model-fixtures.js";

const agentId = parseAgentId("primary");
const revision: AgentRevisionSnapshot = {
  revisionId: "rev_test",
  definitionRevisionId: "def_tool_proposal",
  modelProfileRevisionId: TEST_MODEL_PROFILE_REVISION_ID,
  agentId,
  displayName: "Primary",
  prompt: "You are the primary Agent.",
  model: testModelRuntime(),
  workspace: "C:/workspace",
  skills: [],
  policy: [],
  delegates: [],
  limits: DEFAULT_RUN_LIMITS,
  contentSha256: "0".repeat(64),
};

const listArgumentsSchema = z.strictObject({
  path: z.string(),
  maxEntries: z.number().int().positive(),
});

const listFilesTool: ToolDefinition = {
  name: "list_files",
  effect: "read_only",
  async parseAndNormalize(raw) {
    listArgumentsSchema.parse(raw);
    return {
      arguments: { ...(raw as Record<string, JsonValue>) },
      policyFacts: { pathWithinWorkspace: true },
    };
  },
  async execute() {
    return {
      ok: true,
      summary: "listed",
      content: [],
      capturedBytes: 0,
      truncated: false,
    };
  },
};

describe("normalizeToolProposal", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(listFilesTool);
  });

  it("hashes normalized arguments using RFC 8785 ordering", async () => {
    const first = await normalizeToolProposal(
      input(registry, { path: ".", maxEntries: 20 }),
    );
    const second = await normalizeToolProposal(
      input(registry, { maxEntries: 20, path: "." }),
    );

    const canonical = '{"maxEntries":20,"path":"."}';
    expect(first.canonicalArguments).toBe(canonical);
    expect(second.canonicalArguments).toBe(canonical);
    expect(first.argumentsSha256).toBe(
      createHash("sha256").update(canonical, "utf8").digest("hex"),
    );
  });

  it("preserves only canonical provider call IDs", async () => {
    const proposal = await normalizeToolProposal(
      input(registry, { path: ".", maxEntries: 20 }),
    );

    expect(proposal.providerCallId).toBe("call_provider_7");
    for (const providerCallId of ["", "has space", "line\nbreak", "x".repeat(201)]) {
      await expect(normalizeToolProposal({
        ...input(registry, { path: ".", maxEntries: 20 }),
        providerCallId,
      })).rejects.toMatchObject({ code: "model_protocol_error" });
    }
  });

  it("persists and recovers a provider call ID for every new proposal", () => {
    const connection = openDatabase({ path: ":memory:", busyTimeoutMs: 5_000 });
    try {
      migrate(connection.db);
      const runId = runIdFromUuid("00000000-0000-7000-8000-000000000007");
      const sessionId = sessionIdFromUuid("00000000-0000-7000-8000-000000000007");
      const toolCallId = toolCallIdFromUuid("00000000-0000-7000-8000-000000000007");
      seedRunningRun(connection.db, runId, sessionId);
      const repository = new SqliteToolRepository(connection.db);

      const stored = repository.recordProposal({
        runId,
        leaseOwner: "worker-unit",
        toolCallId,
        providerCallId: "call_provider_7",
        toolName: "list_files",
        effect: "read_only",
        arguments: { path: ".", maxEntries: 20 },
        canonicalArguments: '{"maxEntries":20,"path":"."}',
        argumentsSha256: "7".repeat(64),
        policyFacts: { pathWithinWorkspace: true },
        policyEffect: "allow",
        matchedRule: 0,
        toolCallLimit: 12,
        occurredAt: new Date("2026-08-09T00:00:00.000Z"),
      });

      expect(stored.providerCallId).toBe("call_provider_7");
      expect(repository.getLatestForRun(runId)?.providerCallId).toBe(
        "call_provider_7",
      );
      expect(connection.db.prepare(
        "SELECT provider_call_id FROM tool_calls WHERE tool_call_id = ?",
      ).get(toolCallId)).toEqual({ provider_call_id: "call_provider_7" });
    } finally {
      connection.close();
    }
  });

  it("lists Tool Calls in durable insertion order", () => {
    const connection = openDatabase({ path: ":memory:", busyTimeoutMs: 5_000 });
    try {
      migrate(connection.db);
      const runId = runIdFromUuid("00000000-0000-7000-8000-000000000008");
      const sessionId = sessionIdFromUuid("00000000-0000-7000-8000-000000000008");
      seedRunningRun(connection.db, runId, sessionId);
      const repository = new SqliteToolRepository(connection.db);
      const first = toolCallIdFromUuid("00000000-0000-7000-8000-000000000009");
      const second = toolCallIdFromUuid("00000000-0000-7000-8000-000000000001");
      const base = {
        runId,
        leaseOwner: "worker-unit",
        toolName: "list_files",
        effect: "read_only" as const,
        arguments: { path: "." },
        canonicalArguments: '{"path":"."}',
        argumentsSha256: "8".repeat(64),
        policyFacts: { pathWithinWorkspace: true } as const,
        policyEffect: "allow" as const,
        matchedRule: 0,
        toolCallLimit: 12,
        occurredAt: new Date("2026-08-09T00:00:00.000Z"),
      };

      repository.recordProposal({
        ...base,
        toolCallId: first,
        providerCallId: "call_provider_first",
      });
      repository.recordProposal({
        ...base,
        toolCallId: second,
        providerCallId: "call_provider_second",
      });

      expect(repository.listForRun(runId).map((call) => call.toolCallId)).toEqual([
        first,
        second,
      ]);
      expect(repository.getLatestForRun(runId)?.toolCallId).toBe(second);
    } finally {
      connection.close();
    }
  });

  it("reuses only the root provider ID when an internal reconciliation retry completes", () => {
    const connection = openDatabase({ path: ":memory:", busyTimeoutMs: 5_000 });
    try {
      migrate(connection.db);
      const runId = runIdFromUuid("00000000-0000-7000-8000-000000000012");
      const sessionId = sessionIdFromUuid("00000000-0000-7000-8000-000000000012");
      const originalId = toolCallIdFromUuid("00000000-0000-7000-8000-000000000012");
      const retryId = toolCallIdFromUuid("00000000-0000-7000-8000-000000000013");
      seedRunningRun(connection.db, runId, sessionId);
      const repository = new SqliteToolRepository(connection.db);
      repository.recordProposal({
        runId,
        leaseOwner: "worker-unit",
        toolCallId: originalId,
        providerCallId: "call_provider_root",
        toolName: "run_command",
        effect: "side_effect",
        arguments: { command: "echo hi" },
        canonicalArguments: '{"command":"echo hi"}',
        argumentsSha256: "c".repeat(64),
        policyFacts: {},
        policyEffect: "allow",
        matchedRule: 0,
        toolCallLimit: 12,
        occurredAt: new Date("2026-08-09T00:00:00.000Z"),
      });
      repository.beginExecution({
        runId,
        toolCallId: originalId,
        leaseOwner: "worker-unit",
        occurredAt: new Date("2026-08-09T00:00:01.000Z"),
      });
      repository.markExecutionUnknown({
        runId,
        toolCallId: originalId,
        leaseOwner: "worker-unit",
        occurredAt: new Date("2026-08-09T00:00:02.000Z"),
      });
      repository.reconcile({
        toolCallId: originalId,
        outcome: "retry",
        note: "safe to retry",
        retryToolCallId: retryId,
        policyEffect: "allow",
        matchedRule: 0,
        toolCallLimit: 12,
        occurredAt: new Date("2026-08-09T00:00:03.000Z"),
      });
      const retryResult = {
        ok: true,
        summary: "executed",
        content: { stdout: "hi" },
        capturedBytes: 2,
        truncated: false,
      };
      connection.db.prepare(
        "UPDATE tool_calls SET state = 'succeeded', result_json = ? WHERE tool_call_id = ?",
      ).run(JSON.stringify(retryResult), retryId);

      expect(connection.db.prepare(
        "SELECT provider_call_id FROM tool_calls WHERE tool_call_id = ?",
      ).get(retryId)).toEqual({ provider_call_id: null });
      expect(completedToolResults(repository.listForRun(runId))).toEqual([{
        providerCallId: "call_provider_root",
        toolName: "run_command",
        arguments: { command: "echo hi" },
        content: retryResult,
      }]);
    } finally {
      connection.close();
    }
  });

  it("rejects a completed original proposal whose provider call ID is missing or invalid", () => {
    const baseCall: Omit<ToolCall, "providerCallId"> = {
      toolCallId: toolCallIdFromUuid("00000000-0000-7000-8000-000000000014"),
      runId: runIdFromUuid("00000000-0000-7000-8000-000000000014"),
      state: "succeeded",
      toolName: "list_files",
      effect: "read_only",
      arguments: { path: ".", maxEntries: 20 },
      canonicalArguments: '{"maxEntries":20,"path":"."}',
      argumentsSha256: "d".repeat(64),
      policyEffect: "allow",
      matchedRule: 0,
      policyFacts: { pathWithinWorkspace: true },
      retryOfToolCallId: null,
      result: { ok: true, content: [] },
      createdAt: new Date("2026-08-09T00:00:00.000Z"),
      updatedAt: new Date("2026-08-09T00:00:01.000Z"),
    };

    for (const providerCallId of [null, "call provider invalid"] as const) {
      const call = { ...baseCall, providerCallId } satisfies ToolCall;
      expect(() => completedToolResults([call])).toThrowError(
        expect.objectContaining({ code: "model_protocol_error" }),
      );
    }
  });

  it("rejects unknown fields before policy evaluation", async () => {
    await expect(
      normalizeToolProposal(
        input(registry, { path: ".", maxEntries: 20, grantsAdmin: true }),
      ),
    ).rejects.toMatchObject({ code: "invalid_tool_arguments" });
  });

  it("rejects unknown Tools before normalization", async () => {
    await expect(
      normalizeToolProposal({
        ...input(registry, {}),
        toolName: "missing_tool",
      }),
    ).rejects.toMatchObject({ code: "tool_not_found" });
  });

  it("rejects non-JSON normalized output", async () => {
    registry.register({
      name: "bad_output",
      effect: "read_only",
      async parseAndNormalize() {
        return {
          arguments: { value: Number.POSITIVE_INFINITY } as unknown as JsonValue,
          policyFacts: {},
        };
      },
      async execute() {
        throw new Error("not used");
      },
    });

    await expect(
      normalizeToolProposal({
        ...input(registry, {}),
        toolName: "bad_output",
      }),
    ).rejects.toMatchObject({ code: "invalid_tool_arguments" });
  });

  it("preserves JSON keys that overlap object prototype names", async () => {
    registry.register({
      name: "echo",
      effect: "internal",
      async parseAndNormalize(raw) {
        return { arguments: raw, policyFacts: {} };
      },
      async execute() {
        throw new Error("not used");
      },
    });
    const argumentsValue = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"safe"}',
    ) as JsonValue;

    const proposal = await normalizeToolProposal({
      ...input(registry, argumentsValue),
      toolName: "echo",
    });

    expect(proposal.canonicalArguments).toBe(
      '{"__proto__":{"polluted":true},"constructor":"safe"}',
    );
  });

  it("does not retain parser details in invalid argument errors", async () => {
    registry.register({
      name: "sensitive_parser",
      effect: "side_effect",
      async parseAndNormalize() {
        throw new Error("provider token must-not-escape");
      },
      async execute() {
        throw new Error("not used");
      },
    });

    const error = await normalizeToolProposal({
      ...input(registry, {}),
      toolName: "sensitive_parser",
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "invalid_tool_arguments",
      message: "invalid_tool_arguments",
      details: undefined,
    });
    expect(String(error)).not.toContain("must-not-escape");
  });

  it("deeply freezes normalized arguments and trusted policy facts", async () => {
    registry.register({
      name: "nested",
      effect: "internal",
      async parseAndNormalize(raw) {
        return {
          arguments: raw,
          policyFacts: { targetAgentInDelegates: true },
        };
      },
      async execute() {
        throw new Error("not used");
      },
    });

    const proposal = await normalizeToolProposal({
      ...input(registry, { nested: { value: 1 } }),
      toolName: "nested",
      policyFacts: { pathWithinWorkspace: true },
    } as NormalizeToolProposalInput & {
      policyFacts: { pathWithinWorkspace: true };
    });

    expect(Object.isFrozen(proposal.arguments)).toBe(true);
    expect(Object.isFrozen((proposal.arguments as { nested: object }).nested)).toBe(true);
    expect(Object.isFrozen(proposal.policyFacts)).toBe(true);
    expect(proposal.policyFacts).toEqual({ targetAgentInDelegates: true });
  });
});

describe("ToolRegistry", () => {
  it("rejects duplicate Tool names", () => {
    const registry = new ToolRegistry();
    registry.register(listFilesTool);

    expect(() => registry.register(listFilesTool)).toThrow(
      "duplicate Tool: list_files",
    );
  });
});

function input(
  registry: ToolRegistry,
  argumentsValue: JsonValue,
): NormalizeToolProposalInput {
  return {
    registry,
    providerCallId: "call_provider_7",
    toolName: "list_files",
    arguments: argumentsValue,
    context: { agentId, revision },
  };
}

function seedRunningRun(
  db: ReturnType<typeof openDatabase>["db"],
  runId: ReturnType<typeof runIdFromUuid>,
  sessionId: ReturnType<typeof sessionIdFromUuid>,
): void {
  const now = "2026-08-09T00:00:00.000Z";
  db.prepare(
    `INSERT INTO agent_revisions (
       revision_id, agent_id, content_json, content_sha256, created_at
     ) VALUES ('rev_test', 'primary', '{}', ?, ?)`,
  ).run("a".repeat(64), now);
  db.prepare(
    `INSERT INTO sessions (
       session_id, agent_id, session_key, agent_revision_id,
       owner_session_id, current_summary_id, created_at, updated_at
     ) VALUES (?, 'primary', 'unit:provider-call-id', 'rev_test', NULL, NULL, ?, ?)`,
  ).run(sessionId, now, now);
  db.prepare(
    `INSERT INTO runs (
       run_id, session_id, agent_revision_id, state, fifo_sequence,
       parent_run_id, root_run_id, delegation_depth, blocked_by_child_run_id,
       lease_owner, lease_expires_at, active_started_at, request_digest,
       input_json, created_at, updated_at
     ) VALUES (?, ?, 'rev_test', 'running', 0, NULL, ?, 0, NULL,
       'worker-unit', '2026-08-09T00:01:00.000Z', ?, ?, ?, ?, ?)`,
  ).run(runId, sessionId, runId, now, "digest", '{"type":"text","text":"hi"}', now, now);
}
