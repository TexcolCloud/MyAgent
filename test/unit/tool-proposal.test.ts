import { createHash } from "node:crypto";

import { z } from "zod";
import { beforeEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../../src/adapters/tools/registry.js";
import {
  normalizeToolProposal,
  type NormalizeToolProposalInput,
} from "../../src/application/tool-proposal.js";
import type { AgentRevisionSnapshot } from "../../src/domain/agent-revision.js";
import { parseAgentId } from "../../src/domain/ids.js";
import type { JsonValue } from "../../src/domain/json.js";
import { DEFAULT_RUN_LIMITS } from "../../src/domain/limits.js";
import type { ToolDefinition } from "../../src/ports/tool.js";

const agentId = parseAgentId("primary");
const revision: AgentRevisionSnapshot = {
  revisionId: "rev_test",
  agentId,
  displayName: "Primary",
  prompt: "You are the primary Agent.",
  model: {
    provider: "openai-compatible",
    model: "test-model",
    baseUrl: "https://example.invalid/v1",
    apiKey: { fromEnvironment: "TEST_API_KEY" },
    maxInputTokens: 8_192,
  },
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
    toolName: "list_files",
    arguments: argumentsValue,
    context: { agentId, revision },
  };
}
