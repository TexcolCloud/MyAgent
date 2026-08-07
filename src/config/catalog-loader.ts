import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import canonicalizeModule from "canonicalize";
import { parse as parseYaml } from "yaml";

import type {
  AgentRevisionSnapshot,
  PolicyRule,
  SkillSnapshot,
} from "../domain/agent-revision.js";
import { DomainError } from "../domain/errors.js";
import { parseAgentId, type AgentId } from "../domain/ids.js";
import { DEFAULT_RUN_LIMITS, type RunLimits } from "../domain/limits.js";
import {
  agentConfigSchema,
  globalConfigSchema,
  policyConfigSchema,
  type AgentConfig,
  type GlobalConfig,
  type PolicyConfig,
} from "./schemas.js";
import { loadSkillCatalog, type SkillCatalog } from "./skill-loader.js";

const canonicalizeJson = canonicalizeModule as unknown as (
  input: unknown,
) => string | undefined;

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type ResolvedGlobalConfig = DeepReadonly<
  Omit<GlobalConfig, "agentRoots" | "skillRoots"> & {
    agentRoots: string[];
    skillRoots: string[];
  }
>;

export interface AvailableAgent {
  id: AgentId;
  revision: AgentRevisionSnapshot;
}

export interface UnavailableAgent {
  id: string;
  code: "invalid_agent_config";
  detail: string;
}

export interface CatalogSnapshot {
  configPath: string;
  global: ResolvedGlobalConfig;
  available: readonly AvailableAgent[];
  unavailable: readonly UnavailableAgent[];
  byId: ReadonlyMap<AgentId, AvailableAgent>;
}

export async function loadCatalog(configPath: string): Promise<CatalogSnapshot> {
  const absoluteConfigPath = path.resolve(configPath);
  const configDirectory = path.dirname(absoluteConfigPath);
  const global = await loadGlobalConfig(absoluteConfigPath, configDirectory);
  const { skills, agentDirectories } = await loadGlobalResources(global);
  const available: AvailableAgent[] = [];
  const unavailable: UnavailableAgent[] = [];

  for (const directory of agentDirectories) {
    const result = await loadAgent(directory, global, skills);
    if ("revision" in result) {
      available.push(result);
    } else {
      unavailable.push(result);
    }
  }

  const isolated = isolateDuplicateAgents(available, unavailable);
  isolated.available.sort((left, right) => left.id.localeCompare(right.id));
  isolated.unavailable.sort((left, right) => left.id.localeCompare(right.id));

  return Object.freeze({
    configPath: absoluteConfigPath,
    global,
    available: Object.freeze(isolated.available),
    unavailable: Object.freeze(isolated.unavailable),
    byId: new Map(isolated.available.map((agent) => [agent.id, agent])),
  });
}

interface GlobalResources {
  skills: SkillCatalog;
  agentDirectories: string[];
}

async function loadGlobalResources(
  global: ResolvedGlobalConfig,
): Promise<GlobalResources> {
  try {
    const [skills, agentDirectories] = await Promise.all([
      loadSkillCatalog(global.skillRoots),
      discoverAgentDirectories(global.agentRoots),
    ]);
    return { skills, agentDirectories };
  } catch (error) {
    throw new DomainError(
      "invalid_global_config",
      "invalid_global_config: configured root is unavailable",
      { cause: error instanceof Error ? error.message : "unknown" },
    );
  }
}

interface IsolatedAgents {
  available: AvailableAgent[];
  unavailable: UnavailableAgent[];
}

function isolateDuplicateAgents(
  available: readonly AvailableAgent[],
  unavailable: readonly UnavailableAgent[],
): IsolatedAgents {
  const counts = new Map<string, number>();
  for (const agent of available) {
    counts.set(agent.id, (counts.get(agent.id) ?? 0) + 1);
  }
  for (const agent of unavailable) {
    counts.set(agent.id, (counts.get(agent.id) ?? 0) + 1);
  }

  const duplicateIds = new Set(
    [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([agentId]) => agentId),
  );
  const isolatedUnavailable = unavailable.filter(
    (agent) => !duplicateIds.has(agent.id),
  );
  for (const id of duplicateIds) {
    isolatedUnavailable.push({
      id,
      code: "invalid_agent_config",
      detail: `duplicate Agent ID: ${id}`,
    });
  }

  return {
    available: available.filter((agent) => !duplicateIds.has(agent.id)),
    unavailable: isolatedUnavailable,
  };
}

async function loadGlobalConfig(
  configPath: string,
  configDirectory: string,
): Promise<ResolvedGlobalConfig> {
  try {
    const parsed = globalConfigSchema.parse(parseYaml(await readFile(configPath, "utf8")));
    return deepFreeze({
      ...parsed,
      database: {
        ...parsed.database,
        path: path.resolve(configDirectory, parsed.database.path),
      },
      agentRoots: parsed.agentRoots.map((root) => path.resolve(configDirectory, root)),
      skillRoots: parsed.skillRoots.map((root) => path.resolve(configDirectory, root)),
    });
  } catch (error) {
    throw new DomainError(
      "invalid_global_config",
      "invalid_global_config",
      { cause: error instanceof Error ? error.message : "unknown" },
    );
  }
}

async function discoverAgentDirectories(roots: readonly string[]): Promise<string[]> {
  const directories: string[] = [];
  for (const root of roots) {
    const canonicalRoot = await realpath(root);
    const entries = await readdir(canonicalRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        directories.push(path.join(canonicalRoot, entry.name));
      }
    }
  }

  return directories.sort((left, right) => left.localeCompare(right));
}

async function loadAgent(
  directory: string,
  global: ResolvedGlobalConfig,
  skills: SkillCatalog,
): Promise<AvailableAgent | UnavailableAgent> {
  let fallbackId = path.basename(directory);
  try {
    const raw = parseYaml(await readFile(path.join(directory, "agent.yaml"), "utf8"));
    if (isObject(raw) && typeof raw.id === "string") {
      fallbackId = raw.id;
    }

    const config = agentConfigSchema.parse(raw);
    const id = parseAgentId(config.id);
    const model = global.models[config.model];
    if (model === undefined) {
      throw new Error(`unknown model: ${config.model}`);
    }

    const promptPath = await confinedFile(directory, config.prompt);
    const policyPath = await confinedFile(directory, config.policy);
    const prompt = await readFile(promptPath, "utf8");
    const policy = policyConfigSchema.parse(
      parseYaml(await readFile(policyPath, "utf8")),
    );
    const selectedSkills = config.skills.map((name) => {
      const loadError = skills.unavailable.get(name);
      if (loadError !== undefined) {
        throw loadError;
      }
      const skill = skills.available.get(name);
      if (skill === undefined) {
        throw new Error(`missing allowlisted Skill: ${name}`);
      }
      return skill;
    });
    const revision = buildRevision({
      id,
      config,
      prompt,
      rawPolicy: policy.rules,
      model,
      directory,
      skills: selectedSkills,
    });
    return Object.freeze({ id, revision });
  } catch (error) {
    return Object.freeze({
      id: fallbackId,
      code: "invalid_agent_config" as const,
      detail: error instanceof Error ? error.message : "invalid Agent configuration",
    });
  }
}

async function confinedFile(root: string, candidate: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const canonicalCandidate = await realpath(path.resolve(root, candidate));
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("path escapes Agent directory");
  }

  return canonicalCandidate;
}

interface BuildRevisionInput {
  id: AgentId;
  config: AgentConfig;
  prompt: string;
  rawPolicy: PolicyConfig["rules"];
  model: ResolvedGlobalConfig["models"][string];
  directory: string;
  skills: readonly SkillSnapshot[];
}

function buildRevision(input: BuildRevisionInput): AgentRevisionSnapshot {
  const { id, config, prompt, rawPolicy, model, directory, skills } = input;
  const policy: PolicyRule[] = rawPolicy.map((rule) => ({
    tool: rule.tool,
    effect: rule.effect,
    ...(rule.when === undefined ? {} : { when: rule.when }),
    ...(rule.agent === undefined
      ? {}
      : { agent: rule.agent === "*" ? "*" : parseAgentId(rule.agent) }),
  }));
  const limits = resolveRunLimits(config.limits);
  const content = {
    agentId: id,
    displayName: config.displayName,
    prompt,
    model,
    workspace: path.resolve(directory, config.workspace),
    skills: Object.freeze([...skills]),
    policy,
    delegates: config.delegates.map(parseAgentId),
    limits,
  };
  const canonical = canonicalizeJson(content);
  if (canonical === undefined) {
    throw new Error("revision is not canonicalizable");
  }

  const contentSha256 = createHash("sha256").update(canonical).digest("hex");
  return deepFreeze({
    ...content,
    revisionId: `rev_${contentSha256}`,
    contentSha256,
  });
}

function resolveRunLimits(overrides: AgentConfig["limits"]): RunLimits {
  return {
    modelTurns: overrides.modelTurns ?? DEFAULT_RUN_LIMITS.modelTurns,
    toolCalls: overrides.toolCalls ?? DEFAULT_RUN_LIMITS.toolCalls,
    childRuns: overrides.childRuns ?? DEFAULT_RUN_LIMITS.childRuns,
    delegationDepth:
      overrides.delegationDepth ?? DEFAULT_RUN_LIMITS.delegationDepth,
    activeExecutionSeconds:
      overrides.activeExecutionSeconds ?? DEFAULT_RUN_LIMITS.activeExecutionSeconds,
    defaultToolTimeoutMs:
      overrides.defaultToolTimeoutMs ?? DEFAULT_RUN_LIMITS.defaultToolTimeoutMs,
    maxToolTimeoutMs:
      overrides.maxToolTimeoutMs ?? DEFAULT_RUN_LIMITS.maxToolTimeoutMs,
    maxToolOutputBytes:
      overrides.maxToolOutputBytes ?? DEFAULT_RUN_LIMITS.maxToolOutputBytes,
    maxRunToolOutputBytes:
      overrides.maxRunToolOutputBytes ?? DEFAULT_RUN_LIMITS.maxRunToolOutputBytes,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
