import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { stringify as stringifyYaml } from "yaml";

import {
  type CatalogSnapshot,
  validateAgentDirectory,
} from "../config/catalog-loader.js";
import { CatalogService } from "../config/catalog-service.js";
import { policyConfigSchema } from "../config/schemas.js";
import { ApplicationError } from "../domain/errors.js";
import { parseAgentId } from "../domain/ids.js";
import type { PolicyRule } from "../domain/policy.js";

export interface CreateManagedAgentInput {
  readonly id: string;
  readonly displayName: string;
  readonly prompt: string;
  readonly workspace: string;
  readonly policy: { readonly rules: readonly PolicyRule[] };
  readonly expectedCatalogRevision: string;
}

export interface CreatedManagedAgent {
  readonly catalogRevision: string;
  readonly agent: {
    readonly id: string;
    readonly displayName: string;
    readonly revisionId: string;
    readonly assignment: { readonly state: "unassigned" };
  };
}

interface CreateManagedAgentDependencies {
  readonly writeFile?: (file: string, content: string) => Promise<void>;
  readonly afterReload?: (candidate: CatalogSnapshot) => void;
}

export class CreateManagedAgentService {
  constructor(
    private readonly catalog: CatalogService,
    private readonly dependencies: CreateManagedAgentDependencies = {},
  ) {}

  async execute(input: CreateManagedAgentInput): Promise<CreatedManagedAgent> {
    return runCatalogExclusive(this.catalog, () => this.create(input));
  }

  private async create(input: CreateManagedAgentInput): Promise<CreatedManagedAgent> {
    this.catalog.assertRevision(input.expectedCatalogRevision);
    const id = parseManagedAgentId(input.id);
    const managedRoot = await resolveManagedRoot(this.catalog.current());
    assertManagedRelativePath(input.workspace);
    const policy = parsePolicy(input.policy);
    if (this.catalog.current().byId.has(id)) throw new ApplicationError("managed_agent_exists", 409);

    const target = path.join(managedRoot, id);
    if (await pathExists(target)) throw new ApplicationError("managed_agent_exists", 409);
    const ownershipToken = randomUUID();
    const temporary = path.join(
      path.dirname(managedRoot),
      `.managed-agent-${id}-tmp-${ownershipToken}`,
    );
    const ownershipFile = ".managed-agent-owner";
    const initialSnapshot = this.catalog.current();
    let committedSnapshot: CatalogSnapshot | undefined;
    let renamed = false;
    try {
      await mkdir(temporary);
      const write = this.dependencies.writeFile ?? exclusiveWrite;
      await write(path.join(temporary, "agent.yaml"), stringifyYaml({
        id,
        displayName: requireNonempty(input.displayName),
        prompt: "./AGENT.md",
        workspace: input.workspace,
        skills: [],
        policy: "./policy.yaml",
        delegates: [],
        limits: {},
      }));
      await write(path.join(temporary, "AGENT.md"), input.prompt);
      await write(path.join(temporary, "policy.yaml"), stringifyYaml({ version: 1, rules: policy.rules }));
      await exclusiveWrite(path.join(temporary, ownershipFile), ownershipToken);

      const stagedAgent = await validateAgentDirectory(temporary, this.catalog.current().global);
      if (!("definition" in stagedAgent) || stagedAgent.id !== id) {
        throw new ApplicationError("invalid_managed_agent", 422);
      }
      this.catalog.assertRevision(input.expectedCatalogRevision);
      await rename(temporary, target);
      renamed = true;
      const result = await this.catalog.reloadExpected(input.expectedCatalogRevision, (candidate) => {
        const agent = candidate.byId.get(id);
        if (agent === undefined) throw new ApplicationError("invalid_managed_agent", 422);
        this.dependencies.afterReload?.(candidate);
        return {
          agent: {
            id: agent.id,
            displayName: agent.definition.displayName,
            revisionId: agent.definition.definitionRevisionId,
            assignment: { state: "unassigned" as const },
          },
        };
      });
      committedSnapshot = this.catalog.current();
      const catalogRevision = this.catalog.revision();
      await unlink(path.join(target, ownershipFile));
      return { ...result, catalogRevision };
    } catch (error) {
      if (renamed) {
        await rollbackPublishedAgent(target, temporary, ownershipFile, ownershipToken);
        if (committedSnapshot !== undefined) {
          this.catalog.restoreIfCurrent(committedSnapshot, initialSnapshot);
        }
      } else {
        await rm(temporary, { recursive: true, force: true });
      }
      throw normalizeCreationError(error);
    }
  }
}

const catalogTails = new WeakMap<CatalogService, Promise<void>>();

async function runCatalogExclusive<Result>(
  catalog: CatalogService,
  operation: () => Promise<Result>,
): Promise<Result> {
  const previous = catalogTails.get(catalog) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  catalogTails.set(catalog, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release?.();
    if (catalogTails.get(catalog) === tail) catalogTails.delete(catalog);
  }
}

async function rollbackPublishedAgent(
  target: string,
  quarantine: string,
  ownershipFile: string,
  ownershipToken: string,
): Promise<void> {
  try {
    await rename(target, quarantine);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }

  if (await ownsPublishedDirectory(quarantine, ownershipFile, ownershipToken)) {
    await rm(quarantine, { recursive: true, force: true });
    return;
  }

  if (!await pathExists(target)) await rename(quarantine, target);
}

async function ownsPublishedDirectory(
  directory: string,
  ownershipFile: string,
  ownershipToken: string,
): Promise<boolean> {
  try {
    return await readFile(path.join(directory, ownershipFile), "utf8") === ownershipToken;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function resolveManagedRoot(snapshot: CatalogSnapshot): Promise<string> {
  const projectRoot = path.dirname(snapshot.configPath);
  const expected = path.join(projectRoot, "agents");
  if (path.basename(projectRoot) !== ".myagent" || snapshot.global.agentRoots.length !== 1) {
    throw new ApplicationError("unmanaged_agent_root", 422);
  }
  const [configured] = snapshot.global.agentRoots;
  if (configured === undefined || path.resolve(configured) !== path.resolve(expected)) {
    throw new ApplicationError("unmanaged_agent_root", 422);
  }
  const metadata = await lstat(expected);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ApplicationError("unmanaged_agent_root", 422);
  }
  const [canonicalRoot, canonicalProject] = await Promise.all([realpath(expected), realpath(projectRoot)]);
  if (path.dirname(canonicalRoot) !== canonicalProject || path.basename(canonicalRoot) !== "agents") {
    throw new ApplicationError("unmanaged_agent_root", 422);
  }
  return canonicalRoot;
}

function parseManagedAgentId(value: string) {
  try { return parseAgentId(value); }
  catch { throw new ApplicationError("invalid_managed_agent", 422); }
}

function assertManagedRelativePath(value: string): void {
  if (value.length === 0 || path.isAbsolute(value)) throw new ApplicationError("invalid_managed_agent", 422);
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new ApplicationError("invalid_managed_agent", 422);
  }
}

function parsePolicy(value: CreateManagedAgentInput["policy"]) {
  try {
    const policy = policyConfigSchema.parse({ version: 1, rules: value.rules });
    if (policy.rules.some((rule) => rule.effect === "allow")) {
      throw new Error("managed_agent_allow_policy_forbidden");
    }
    return policy;
  }
  catch { throw new ApplicationError("invalid_managed_agent", 422); }
}

function requireNonempty(value: string): string {
  if (value.length === 0) throw new ApplicationError("invalid_managed_agent", 422);
  return value;
}

async function exclusiveWrite(file: string, content: string): Promise<void> {
  await writeFile(file, content, { encoding: "utf8", flag: "wx" });
}

async function pathExists(candidate: string): Promise<boolean> {
  try { await lstat(candidate); return true; }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function normalizeCreationError(error: unknown): unknown {
  if (error instanceof ApplicationError) return error;
  if (hasErrorCode(error, "EEXIST")) {
    return new ApplicationError("managed_agent_exists", 409);
  }
  return error;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
