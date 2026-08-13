import { randomUUID } from "node:crypto";
import { link, mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";

import { stringify as stringifyYaml } from "yaml";

import { localProjectConfigSchema } from "../../config/schemas.js";

export interface LocalProjectPaths {
  readonly workspace: string;
  readonly root: string;
  readonly configPath: string;
  readonly databasePath: string;
  readonly agentsRoot: string;
  readonly skillsRoot: string;
}

interface InitializeProjectStateDependencies {
  readonly temporaryPath?: (paths: LocalProjectPaths) => string;
  readonly beforeCommit?: () => Promise<void>;
}

export function resolveLocalProjectPaths(
  workspace: string,
  configPath?: string,
): LocalProjectPaths {
  const resolvedWorkspace = path.resolve(workspace);
  const resolvedConfigPath = path.resolve(
    configPath ?? path.join(resolvedWorkspace, ".myagent", "myagent.yaml"),
  );
  const root = path.dirname(resolvedConfigPath);
  return {
    workspace: resolvedWorkspace,
    root,
    configPath: resolvedConfigPath,
    databasePath: path.join(root, "state.sqlite"),
    agentsRoot: path.join(root, "agents"),
    skillsRoot: path.join(root, "skills"),
  };
}

export async function inspectProjectState(
  paths: LocalProjectPaths,
): Promise<"ready" | "absent" | "partial"> {
  const entries = await Promise.all([
    isFile(paths.configPath),
    isDirectory(paths.agentsRoot),
    isDirectory(paths.skillsRoot),
  ]);
  if (entries.every(Boolean)) return "ready";
  if (entries.every((entry) => !entry)) return "absent";
  return "partial";
}

export async function initializeProjectState(
  paths: LocalProjectPaths,
  dependencies: InitializeProjectStateDependencies = {},
): Promise<void> {
  const state = await inspectProjectState(paths);
  if (state !== "absent") {
    throw new Error(`project state is ${state}; initialization requires absent state`);
  }

  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.agentsRoot);
  await mkdir(paths.skillsRoot);

  const config = localProjectConfigSchema.parse({
    version: 2,
    server: {
      host: "127.0.0.1",
      port: 8787,
      bearerToken: { fromEnvironment: "MYAGENT_BEARER_TOKEN" },
      adminToken: { fromEnvironment: "MYAGENT_ADMIN_TOKEN" },
    },
    database: { path: "state.sqlite" },
    agentRoots: ["agents"],
    skillRoots: ["skills"],
    toolEnvironmentAllowlist: [],
  });
  const temporaryPath = dependencies.temporaryPath?.(paths) ?? path.join(
    paths.root,
    `.${path.basename(paths.configPath)}.tmp-${randomUUID()}`,
  );
  let temporary: Awaited<ReturnType<typeof open>> | undefined;
  let ownsTemporaryFile = false;
  try {
    temporary = await open(temporaryPath, "wx");
    ownsTemporaryFile = true;
    await temporary.writeFile(stringifyYaml(config), "utf8");
    await temporary.sync();
    await temporary.close();
    temporary = undefined;
    await dependencies.beforeCommit?.();
    await installCreateOnly(temporaryPath, paths.configPath);
    await rm(temporaryPath);
    ownsTemporaryFile = false;
  } catch (error) {
    try {
      await temporary?.close();
    } finally {
      if (ownsTemporaryFile) await rm(temporaryPath, { force: true });
    }
    throw error;
  }
}

async function installCreateOnly(
  temporaryPath: string,
  configPath: string,
): Promise<void> {
  try {
    await link(temporaryPath, configPath);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      throw new Error("project state was created concurrently");
    }
    throw error;
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code
  );
}
