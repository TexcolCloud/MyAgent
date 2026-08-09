import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import canonicalizeModule from "canonicalize";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { parseAgentId, type AgentId } from "../domain/ids.js";
import type {
  LegacyModelImportSeed,
  LegacyModelSeed,
} from "../ports/model-registry-store.js";
import {
  globalConfigV2Schema,
  legacyGlobalConfigV1Schema,
  type GlobalConfigV2,
  type LegacyGlobalConfigV1,
} from "./schemas.js";

const canonicalizeJson = canonicalizeModule as unknown as (
  input: unknown,
) => string | undefined;

const legacyAgentAliasSchema = z.object({
  id: z.string(),
  model: z.string().min(1),
}).passthrough();

type DeepReadonly<T> = T extends string | number | boolean | bigint | symbol | null | undefined
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type { GlobalConfigV2, LegacyGlobalConfigV1, LegacyModelSeed };

export type BootConfig = DeepReadonly<GlobalConfigV2 | LegacyGlobalConfigV1> & {
  readonly legacyModelImport?: LegacyModelImportSeed;
};

export async function loadBootConfig(configPath: string): Promise<BootConfig> {
  const absoluteConfigPath = path.resolve(configPath);
  const source = await readFile(absoluteConfigPath, "utf8");
  const raw = parseYaml(source);

  if (isVersion2(raw)) {
    return deepFreeze(globalConfigV2Schema.parse(raw));
  }

  const legacy = legacyGlobalConfigV1Schema.parse(raw);
  const legacyModelImport = await loadLegacyModelImport(
    legacy,
    path.dirname(absoluteConfigPath),
  );
  return deepFreeze({ ...legacy, legacyModelImport });
}

function isVersion2(raw: unknown): boolean {
  return isObject(raw) && raw.version === 2;
}

async function loadLegacyModelImport(
  legacy: LegacyGlobalConfigV1,
  configDirectory: string,
): Promise<LegacyModelImportSeed> {
  const models = orderedLegacyModels(legacy);
  const agentAliases = await loadLegacyAgentAliases(
    legacy.agentRoots.map((root) => path.resolve(configDirectory, root)),
    models,
  );
  const canonical = canonicalizeJson({ models, agentAliases });
  if (canonical === undefined) throw new Error("legacy import seed is not canonicalizable");

  return deepFreeze({
    sourceSha256: createHash("sha256").update(canonical).digest("hex"),
    models,
    agentAliases,
  });
}

function orderedLegacyModels(
  legacy: LegacyGlobalConfigV1,
): Readonly<Record<string, Omit<LegacyModelSeed, "alias">>> {
  return deepFreeze(Object.fromEntries(
    Object.entries(legacy.models)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([alias, model]) => [alias, {
        providerKind: model.provider,
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        modelId: model.model,
        maxInputTokens: model.maxInputTokens,
      }]),
  ));
}

async function loadLegacyAgentAliases(
  roots: readonly string[],
  models: Readonly<Record<string, Omit<LegacyModelSeed, "alias">>>,
): Promise<Readonly<Record<string, string>>> {
  const aliases = new Map<AgentId, string>();
  for (const root of roots) {
    const canonicalRoot = await realpath(root);
    const entries = await readdir(canonicalRoot, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(canonicalRoot, entry.name))
      .sort((left, right) => left.localeCompare(right));

    for (const directory of directories) {
      const agentPath = await confinedFile(directory, "agent.yaml");
      const raw = parseYaml(await readFile(agentPath, "utf8"));
      const agent = legacyAgentAliasSchema.parse(raw);
      const id = parseAgentId(agent.id);
      if (models[agent.model] === undefined) {
        throw new Error(`unknown legacy model alias: ${agent.model}`);
      }
      if (aliases.has(id)) throw new Error(`duplicate legacy Agent ID: ${id}`);
      aliases.set(id, agent.model);
    }
  }

  return deepFreeze(Object.fromEntries(
    [...aliases.entries()].sort(([left], [right]) => left.localeCompare(right)),
  ));
}

async function confinedFile(root: string, candidate: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const canonicalCandidate = await realpath(path.resolve(root, candidate));
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("legacy Agent path escapes Agent directory");
  }
  return canonicalCandidate;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value as DeepReadonly<T>;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value) as DeepReadonly<T>;
}
