import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import canonicalizeModule from "canonicalize";
import { parse as parseYaml } from "yaml";

import type {
  AgentDefinitionRevision,
  PolicyRule,
  SkillSnapshot,
} from "../domain/agent-revision.js";
import { DomainError } from "../domain/errors.js";
import { parseAgentId, type AgentId } from "../domain/ids.js";
import { DEFAULT_RUN_LIMITS, type RunLimits } from "../domain/limits.js";
import {
  agentConfigV1Schema,
  agentConfigV2Schema,
  policyConfigSchema,
  type AgentConfigV1,
  type AgentConfigV2,
  type GlobalConfigV2,
  type LegacyGlobalConfigV1,
  type PolicyConfig,
} from "./schemas.js";
import { loadBootConfig, type BootConfig } from "./boot-config.js";
import { loadSkillCatalog, type SkillCatalog } from "./skill-loader.js";

const canonicalizeJson = canonicalizeModule as unknown as (
  input: unknown,
) => string | undefined;

type DeepReadonly<T> = T extends string | number | boolean | bigint | symbol | null | undefined
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

type ResolvedConfig<Config extends GlobalConfigV2 | LegacyGlobalConfigV1> =
  Omit<Config, "agentRoots" | "skillRoots"> & {
    agentRoots: string[];
    skillRoots: string[];
  };

export type ResolvedGlobalConfig = DeepReadonly<
  | ResolvedConfig<GlobalConfigV2>
  | (ResolvedConfig<LegacyGlobalConfigV1> & Pick<BootConfig, "legacyModelImport">)
>;

export interface AvailableAgent {
  id: AgentId;
  definition: AgentDefinitionRevision;
  sources?: readonly CatalogSourceFile[];
}

export interface CatalogSourceFile {
  relativePath: string;
  content: string;
}

export interface UnavailableAgent {
  sourceLabel: string;
  code: "invalid_agent_config";
  detail: string;
}

export interface CatalogSnapshot {
  configPath: string;
  global: ResolvedGlobalConfig;
  available: readonly AvailableAgent[];
  unavailable: readonly UnavailableAgent[];
  byId: ReadonlyMap<AgentId, AvailableAgent>;
  sources: readonly CatalogSourceFile[];
}

export async function loadCatalog(configPath: string): Promise<CatalogSnapshot> {
  const absoluteConfigPath = path.resolve(configPath);
  const configDirectory = path.dirname(absoluteConfigPath);
  const globalSource = await readGlobalConfig(absoluteConfigPath);
  const global = await loadGlobalConfig(absoluteConfigPath, configDirectory);
  const { skills, agentDirectories } = await loadGlobalResources(global);
  const available: AvailableAgent[] = [];
  const unavailable: UnavailableAgent[] = [];

  for (const directory of agentDirectories) {
    const result = await loadAgent(directory, global, skills);
    if ("definition" in result) {
      available.push(result);
    } else {
      unavailable.push(result);
    }
  }

  const isolated = isolateDuplicateAgents(available, unavailable);
  isolated.available.sort((left, right) => left.id.localeCompare(right.id));
  isolated.unavailable.sort((left, right) =>
    left.sourceLabel.localeCompare(right.sourceLabel)
  );

  const sourceFiles = new Map<string, CatalogSourceFile>();
  sourceFiles.set("myagent.yaml", Object.freeze({ relativePath: "myagent.yaml", content: globalSource }));
  for (const agent of isolated.available) {
    for (const source of agent.sources ?? []) sourceFiles.set(source.relativePath, source);
    for (const skill of agent.definition.skills) {
      const source = skills.sources.get(skill.name);
      if (source === undefined) throw new DomainError("active_skill_source_missing");
      const relativePath = `skills/${skill.name}/SKILL.md`;
      sourceFiles.set(relativePath, Object.freeze({ relativePath, content: source.source }));
    }
  }

  return Object.freeze({
    configPath: absoluteConfigPath,
    global,
    available: Object.freeze(isolated.available),
    unavailable: Object.freeze(isolated.unavailable),
    byId: new Map(isolated.available.map((agent) => [agent.id, agent])),
    sources: Object.freeze([...sourceFiles.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath))),
  });
}

async function readGlobalConfig(configPath: string): Promise<string> {
  try {
    return await readFile(configPath, "utf8");
  } catch (error) {
    throw new DomainError(
      "invalid_global_config",
      "invalid_global_config",
      { cause: error instanceof Error ? error.message : "unknown" },
    );
  }
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
    counts.set(
      agent.sourceLabel,
      (counts.get(agent.sourceLabel) ?? 0) + 1,
    );
  }

  const duplicateIds = new Set(
    [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([agentId]) => agentId),
  );
  const isolatedUnavailable = unavailable.filter(
    (agent) => !duplicateIds.has(agent.sourceLabel),
  );
  for (const id of duplicateIds) {
    isolatedUnavailable.push({
      sourceLabel: id,
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
    const parsed = await loadBootConfig(configPath);
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
    const agentConfigPath = await confinedFile(directory, "agent.yaml");
    const agentSource = await readFile(agentConfigPath, "utf8");
    const raw = parseYaml(agentSource);
    if (isObject(raw) && typeof raw.id === "string") {
      fallbackId = raw.id;
    }

    const config = global.version === 1
      ? agentConfigV1Schema.parse(raw)
      : agentConfigV2Schema.parse(raw);
    const id = parseAgentId(config.id);

    const promptPath = await confinedFile(directory, config.prompt);
    const policyPath = await confinedFile(directory, config.policy);
    const prompt = await readFile(promptPath, "utf8");
    const policySource = await readFile(policyPath, "utf8");
    const policy = policyConfigSchema.parse(
      parseYaml(policySource),
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
    const definition = buildDefinition({
      id,
      config,
      prompt,
      rawPolicy: policy.rules,
      directory,
      skills: selectedSkills,
    });
    const sourcePrefix = `agents/${id}`;
    const sources = [
      Object.freeze({ relativePath: `${sourcePrefix}/agent.yaml`, content: agentSource }),
      Object.freeze({ relativePath: `${sourcePrefix}/${relativeSourcePath(directory, promptPath)}`, content: prompt }),
      Object.freeze({ relativePath: `${sourcePrefix}/${relativeSourcePath(directory, policyPath)}`, content: policySource }),
    ];
    return Object.freeze({ id, definition, sources: Object.freeze(sources) });
  } catch (error) {
    return Object.freeze({
      sourceLabel: fallbackId,
      code: "invalid_agent_config" as const,
      detail: error instanceof Error ? error.message : "invalid Agent configuration",
    });
  }
}

function relativeSourcePath(root: string, file: string): string {
  const relative = path.relative(root, file);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("source path escapes Agent directory");
  }
  return relative.split(path.sep).join("/");
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

interface BuildDefinitionInput {
  id: AgentId;
  config: AgentConfigV1 | AgentConfigV2;
  prompt: string;
  rawPolicy: PolicyConfig["rules"];
  directory: string;
  skills: readonly SkillSnapshot[];
}

function buildDefinition(input: BuildDefinitionInput): AgentDefinitionRevision {
  const { id, config, prompt, rawPolicy, directory, skills } = input;
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
    definitionRevisionId: `def_${contentSha256}`,
    contentSha256,
  });
}

function resolveRunLimits(
  overrides: AgentConfigV1["limits"] | AgentConfigV2["limits"],
): RunLimits {
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
