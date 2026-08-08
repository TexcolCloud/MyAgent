import { createHash } from "node:crypto";

import canonicalizeModule from "canonicalize";

import { DomainError } from "../domain/errors.js";
import type { JsonValue } from "../domain/json.js";
import type {
  ToolDefinition,
  ToolNormalizeContext,
  ToolPolicyFacts,
} from "../ports/tool.js";

const canonicalizeJson = canonicalizeModule as unknown as (
  input: unknown,
) => string | undefined;

export interface ToolLookup {
  get(name: string): ToolDefinition | undefined;
}

export interface NormalizeToolProposalInput {
  registry: ToolLookup;
  toolName: string;
  arguments: JsonValue;
  context: ToolNormalizeContext;
}

export interface NormalizedToolProposal {
  toolName: string;
  arguments: JsonValue;
  canonicalArguments: string;
  argumentsSha256: string;
  effect: ToolDefinition["effect"];
  policyFacts: ToolPolicyFacts;
}

export async function normalizeToolProposal(
  input: NormalizeToolProposalInput,
): Promise<NormalizedToolProposal> {
  const tool = input.registry.get(input.toolName);
  if (tool === undefined) {
    throw new DomainError("tool_not_found");
  }

  let normalized: Awaited<ReturnType<ToolDefinition["parseAndNormalize"]>>;
  try {
    normalized = await tool.parseAndNormalize(input.arguments, input.context);
  } catch {
    throw invalidArguments();
  }

  try {
    return buildProposal(tool, normalized.arguments, normalized.policyFacts);
  } catch {
    throw invalidArguments();
  }
}

export function preserveRejectedToolProposal(
  input: Omit<NormalizeToolProposalInput, "context">,
): NormalizedToolProposal {
  const tool = input.registry.get(input.toolName);
  if (tool === undefined) {
    throw new DomainError("tool_not_found");
  }
  try {
    return buildProposal(tool, input.arguments, {});
  } catch {
    throw invalidArguments();
  }
}

function buildProposal(
  tool: ToolDefinition,
  argumentsValue: unknown,
  policyFactsValue: ToolPolicyFacts,
): NormalizedToolProposal {
  const argumentsCopy = copyAndFreezeJson(argumentsValue);
  const policyFacts = copyPolicyFacts(policyFactsValue);
  const canonicalArguments = canonicalizeJson(argumentsCopy);
  if (canonicalArguments === undefined) {
    throw new Error("arguments are not canonicalizable");
  }

  return Object.freeze({
    toolName: tool.name,
    arguments: argumentsCopy,
    canonicalArguments,
    argumentsSha256: createHash("sha256")
      .update(canonicalArguments, "utf8")
      .digest("hex"),
    effect: tool.effect,
    policyFacts,
  });
}

function copyAndFreezeJson(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("non-finite JSON number");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new Error("non-JSON value");
  }
  if (ancestors.has(value)) {
    throw new Error("cyclic JSON value");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const copy = Array.from(value, (item) =>
        copyAndFreezeJson(item, ancestors),
      );
      Object.freeze(copy);
      return copy;
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("non-JSON object");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error("symbol keys are not JSON");
    }

    const copy = Object.create(null) as { [key: string]: JsonValue };
    for (const [key, child] of Object.entries(value)) {
      copy[key] = copyAndFreezeJson(child, ancestors);
    }
    return Object.freeze(copy);
  } finally {
    ancestors.delete(value);
  }
}

function copyPolicyFacts(value: ToolPolicyFacts): ToolPolicyFacts {
  if (!isPlainObject(value)) {
    throw new Error("invalid policy facts");
  }
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) =>
        key !== "pathWithinWorkspace" && key !== "targetAgentInDelegates",
    )
  ) {
    throw new Error("unknown policy fact");
  }

  const facts: ToolPolicyFacts = {};
  if (value.pathWithinWorkspace !== undefined) {
    if (value.pathWithinWorkspace !== true) {
      throw new Error("invalid pathWithinWorkspace fact");
    }
    facts.pathWithinWorkspace = true;
  }
  if (value.targetAgentInDelegates !== undefined) {
    if (value.targetAgentInDelegates !== true) {
      throw new Error("invalid targetAgentInDelegates fact");
    }
    facts.targetAgentInDelegates = true;
  }
  return Object.freeze(facts);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function invalidArguments(): DomainError {
  return new DomainError("invalid_tool_arguments");
}
