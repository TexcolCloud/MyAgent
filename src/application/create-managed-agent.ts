import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { stringify as stringifyYaml } from "yaml";

import type { CatalogSnapshot } from "../config/catalog-loader.js";
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
    this.catalog.assertRevision(input.expectedCatalogRevision);
    const id = parseManagedAgentId(input.id);
    const managedRoot = await resolveManagedRoot(this.catalog.current());
    assertManagedRelativePath(input.workspace);
    const policy = parsePolicy(input.policy);
    if (this.catalog.current().byId.has(id)) throw new ApplicationError("managed_agent_exists", 409);

    const target = path.join(managedRoot, id);
    if (await pathExists(target)) throw new ApplicationError("managed_agent_exists", 409);
    const temporary = path.join(managedRoot, `.managed-agent-${id}-tmp-${randomUUID()}`);
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

      const staged = await this.catalog.validate();
      const stagedAgent = staged.byId.get(id);
      if (stagedAgent === undefined || staged.unavailable.some(({ sourceLabel }) => sourceLabel === id)) {
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
      return { ...result, catalogRevision: this.catalog.revision() };
    } catch (error) {
      if (!renamed) await rm(temporary, { recursive: true, force: true });
      throw normalizeCreationError(error);
    }
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
  try { return policyConfigSchema.parse({ version: 1, rules: value.rules }); }
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
  if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
    return new ApplicationError("managed_agent_exists", 409);
  }
  return error;
}
