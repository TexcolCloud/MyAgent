#!/usr/bin/env node
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { loadBootConfig } from "../../config/boot-config.js";
import { CliClient, CliCredentialError, CliHttpError, CliProtocolError, CliValidationError } from "./client.js";
import { listAgents, setAgentModel } from "./commands/agents.js";
import { listApprovals, decideApproval } from "./commands/approvals.js";
import { createBackup } from "./commands/backup.js";
import { reloadConfig, validateConfig } from "./commands/config.js";
import { doctor } from "./commands/doctor.js";
import { createConsolePrompt, setupModel, type CliPrompt } from "./commands/model-setup.js";
import { createModel, listModels, promoteModel, retireModel, setDefaultModel, verifyModel } from "./commands/models.js";
import { addProvider, discoverProviderModels, listProviders, promoteProvider, retireProvider, updateProvider, type ProviderAuthInput } from "./commands/providers.js";
import { createRun, cancelRun, watchRun } from "./commands/runs.js";
import { rotateMasterKey } from "./commands/secrets.js";
import { serve } from "./commands/serve.js";
import { deleteSession, listSessions } from "./commands/sessions.js";
import { reconcileTool } from "./commands/tools.js";
import { getVerification } from "./commands/verifications.js";
import { writeProblem, type CliProblemOutput, type CliWrite } from "./formatters.js";
import {
  readTuiCredentials,
  TuiCredentialRequiredError,
  TuiTokensMustDifferError,
  type TuiCredentialHelper,
} from "../tui/credentials.js";
import {
  initializeProjectState,
  inspectProjectState,
  resolveLocalProjectPaths,
  type LocalProjectPaths,
} from "../local/project-state.js";
import { assertInteractiveTty, InteractiveTtyRequiredError } from "../tui/tty.js";
import { TuiClient } from "../tui/tui-client.js";
import { runWorkbench, type RunWorkbenchOptions } from "../tui/workbench.js";

export type { CliPrompt } from "./commands/model-setup.js";

export interface ExecuteCliOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  fetcher?: typeof fetch;
  prompt?: CliPrompt;
  readStdin?: () => Promise<string>;
  sleep?: (milliseconds: number) => Promise<void>;
  write?: CliWrite;
  writeError?: CliWrite;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  runTui?: (options: RunWorkbenchOptions) => Promise<void>;
  workspace?: string;
  inspectProjectState?: (paths: LocalProjectPaths) => Promise<"ready" | "absent" | "partial">;
  initializeProjectState?: (paths: LocalProjectPaths) => Promise<void>;
  runLocalHost?: (input: { readonly configPath: string; readonly projectStateRoot: string }) => Promise<number>;
  credentialHelper?: TuiCredentialHelper;
  serveService?: typeof serve;
  validateConfiguration?: typeof validateConfig;
}

export async function executeCli(argumentsList: readonly string[], options: ExecuteCliOptions = {}): Promise<number> {
  const environment = options.environment ?? process.env;
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeError = options.writeError ?? ((line: string) => process.stderr.write(`${line}\n`));
  let json = argumentsList.includes("--json");
  try {
    const { positional, flags } = parseArguments(argumentsList);
    json = booleanFlag(flags, "json");
    if (booleanFlag(flags, "help")) {
      if (positional.length !== 0 || Object.keys(flags).length !== 1) {
        throw new CliUsageError("invalid_cli_command", "The CLI command is invalid.");
      }
      for (const command of publicHelpCommands()) write(command);
      return 0;
    }
    const internal = positional[0] === "internal";
    const commandPositional = internal ? positional.slice(1) : positional;
    const command = commandName(commandPositional);
    const definition = assertCommandGrammar(command, commandPositional.length, flags);
    if (definition.lifecycle === "internal" ? !internal : internal) {
      throw new CliUsageError("invalid_cli_command", "The CLI command is invalid.");
    }
    if (definition.lifecycle === "deprecated") {
      writeError("deprecated_command: This command is deprecated; use the TUI or /v1 HTTP Automation Surface.");
    }
    if (command === "tui") {
      if (booleanFlag(flags, "local") && stringFlag(flags, "api-url") !== undefined) {
        throw new CliUsageError("tui_mode_conflict", "Choose Local or Attached TUI Mode.");
      }
      if (stringFlag(flags, "api-url") === undefined) {
        if (booleanFlag(flags, "allow-remote")) {
          throw new CliUsageError("invalid_cli_option", "Remote attachment requires an API URL.");
        }
        return await executeLocalTui(flags, options);
      }
      if (stringFlag(flags, "config") !== undefined) {
        throw new CliUsageError("invalid_cli_option", "Attached TUI Mode does not use project configuration.");
      }
      assertInteractiveTty({
        stdinIsTTY: options.stdinIsTTY ?? process.stdin.isTTY === true,
        stdoutIsTTY: options.stdoutIsTTY ?? process.stdout.isTTY === true,
      });
      const origin = normalizeAttachedOrigin(requiredFlag(flags, "api-url"));
      const remote = !isLoopbackHostname(origin.hostname);
      if (remote && !booleanFlag(flags, "allow-remote")) {
        throw new CliUsageError("remote_tui_forbidden", "Remote TUI attachment requires --allow-remote.");
      }
      const credentials = await readTuiCredentials({
        environment,
        ...(options.credentialHelper === undefined ? {} : { credentialHelper: options.credentialHelper }),
        promptSecret: (label) => (options.prompt ?? createConsolePrompt()).secret(label),
      });
      writeAttachedSummary(write, origin, credentials.sources);
      if (remote) {
        const confirmation = await (options.prompt ?? createConsolePrompt()).input(
          `Type ${origin.origin} to confirm remote attachment`,
        );
        if (confirmation !== origin.origin) {
          throw new CliUsageError(
            "remote_origin_confirmation_required",
            "Remote attachment requires the exact normalized origin.",
          );
        }
      }
      const workbenchOptions: RunWorkbenchOptions = {
        client: new TuiClient({
          runToken: credentials.runToken,
          adminToken: credentials.adminToken,
          apiUrl: origin.origin,
          ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
        }),
      };
      if (options.runTui !== undefined) await options.runTui(workbenchOptions);
      else await runWorkbench(workbenchOptions);
      return 0;
    }
    if (command === "local") return await executeLocalTui(flags, options);
    if (command === "serve") {
      await (options.serveService ?? serve)(stringFlag(flags, "config") ?? "myagent.yaml");
      return 0;
    }
    if (command === "config validate") {
      await (options.validateConfiguration ?? validateConfig)(
        stringFlag(flags, "config") ?? "myagent.yaml",
        write,
      );
      return 0;
    }

    const bearerToken = stringFlag(flags, "token") ?? environment.MYAGENT_BEARER_TOKEN;
    const adminToken = stringFlag(flags, "admin-token") ?? environment.MYAGENT_ADMIN_TOKEN;
    const client = new CliClient({
      baseUrl: stringFlag(flags, "api-url") ?? requiredEnvironment(environment.MYAGENT_API_URL, "api_url_required", "API URL is required."),
      ...(bearerToken === undefined ? {} : { bearerToken }),
      ...(adminToken === undefined ? {} : { adminToken }),
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    });
    if (definition.authority === "admin" && (adminToken === undefined || adminToken.length === 0)) {
      throw new CliCredentialError("admin");
    }

    if (command === "doctor") {
      return await doctor(client, write, json) ? 0 : 1;
    }

    if (command === "model setup") return await setupModel(
      client,
      options.prompt ?? createConsolePrompt(),
      options.sleep ?? delay,
      write,
      json,
    );
    if (command === "providers add") {
      rejectVisibleApiKey(flags);
      const baseUrl = stringFlag(flags, "base-url");
      const provider = providerSelection(flags);
      await addProvider(client, {
        slug: requiredFlag(flags, "slug"),
        displayName: requiredFlag(flags, "display-name"),
        ...provider,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        auth: await providerAuth(flags, options.readStdin ?? readStandardInput),
        ...(booleanFlag(flags, "allow-insecure-http") ? { allowInsecureHttp: true } : {}),
        ...(stringFlag(flags, "protocol") === undefined ? {} : { protocolPreference: oneOf(requiredFlag(flags, "protocol"), ["chat_completions", "responses"] as const) }),
      }, write);
      return 0;
    }
    if (command === "providers update") {
      rejectVisibleApiKey(flags);
      await updateProvider(client, requiredFlag(flags, "provider"), {
        expectedRevision: revisionFlag(flags),
        displayName: requiredFlag(flags, "display-name"),
        baseUrl: requiredFlag(flags, "base-url"),
        auth: await providerAuth(flags, options.readStdin ?? readStandardInput),
        allowInsecureHttp: booleanFlag(flags, "allow-insecure-http"),
        protocolPreference: oneOf(requiredFlag(flags, "protocol"), ["chat_completions", "responses"] as const),
        ...(stringFlag(flags, "driver") === undefined
          ? {}
          : { driverId: requiredFlag(flags, "driver") }),
      }, write);
      return 0;
    }
    if (command === "providers list") { await listProviders(client, write); return 0; }
    if (command === "providers discover") return await discoverProviderModels(client, requiredFlag(flags, "connection-revision"), revisionFlag(flags), write);
    if (command === "providers promote") { await promoteProvider(client, requiredFlag(flags, "provider"), requiredFlag(flags, "connection-revision"), revisionFlag(flags), write); return 0; }
    if (command === "providers retire") { await retireProvider(client, requiredFlag(flags, "provider"), revisionFlag(flags), write); return 0; }
    if (command === "models create") {
      const selection = modelSelection(flags);
      await createModel(client, {
        slug: requiredFlag(flags, "slug"),
        displayName: requiredFlag(flags, "display-name"),
        connectionRevisionId: requiredFlag(flags, "connection-revision"),
        ...selection,
        ...(stringFlag(flags, "max-input-tokens") === undefined ? {} : { maxInputTokens: positiveIntegerFlag(flags, "max-input-tokens") }),
        ...(stringFlag(flags, "context-source") === undefined ? {} : { contextWindowSource: oneOf(requiredFlag(flags, "context-source"), ["preset", "operator", "assumed_32768"] as const) }),
        ...(booleanFlag(flags, "manual-entry") ? { manualEntryAcknowledged: true } : {}),
      }, write);
      return 0;
    }
    if (command === "models verify") return await verifyModel(client, requiredFlag(flags, "profile-revision"), revisionFlag(flags), options.sleep ?? delay, write);
    if (command === "models promote") { await promoteModel(client, requiredFlag(flags, "model"), requiredFlag(flags, "profile-revision"), revisionFlag(flags), write); return 0; }
    if (command === "models list") { await listModels(client, write); return 0; }
    if (command === "models retire") { await retireModel(client, requiredFlag(flags, "model"), revisionFlag(flags), write); return 0; }
    if (command === "models set-default") { await setDefaultModel(client, requiredFlag(flags, "model"), revisionFlag(flags), write); return 0; }
    if (command === "agents set-model") { await setAgentModel(client, requiredFlag(flags, "agent"), requiredFlag(flags, "profile-revision"), revisionFlag(flags), write); return 0; }
    if (command === "verifications get") return await getVerification(client, requiredFlag(flags, "verification"), write);
    if (command === "secrets rotate-master-key") { await rotateMasterKey(client, revisionFlag(flags), write); return 0; }

    if (command === "config reload") { await reloadConfig(client, write); return 0; }
    if (command === "agents list") { await listAgents(client, write); return 0; }
    if (command === "run create") { await createRun(client, { agentId: requiredFlag(flags, "agent"), sessionKey: requiredFlag(flags, "session"), text: requiredFlag(flags, "text") }, write); return 0; }
    if (command === "run cancel" && commandPositional[2] !== undefined) { await cancelRun(client, commandPositional[2], write); return 0; }
    if (command === "run watch" && commandPositional[2] !== undefined) { await watchRun(client, commandPositional[2], write); return 0; }
    if (command === "approvals list") { await listApprovals(client, write); return 0; }
    if (command === "approvals approve" && commandPositional[2] !== undefined) { await decideApproval(client, commandPositional[2], "approve", write); return 0; }
    if (command === "approvals deny" && commandPositional[2] !== undefined) { await decideApproval(client, commandPositional[2], "deny", write); return 0; }
    if (command === "tools reconcile" && commandPositional[2] !== undefined) { await reconcileTool(client, commandPositional[2], asOutcome(requiredFlag(flags, "as")), write); return 0; }
    if (command === "sessions list") { await listSessions(client, requiredFlag(flags, "agent"), requiredFlag(flags, "session"), write); return 0; }
    if (command === "sessions delete" && commandPositional[2] !== undefined) { await deleteSession(client, commandPositional[2], write); return 0; }
    if (command === "backup" && commandPositional[1] !== undefined) { await createBackup(client, commandPositional[1], write); return 0; }
    throw new CliUsageError("invalid_cli_command", "The CLI command is invalid.");
  } catch (error) {
    const failure = cliFailure(error);
    writeProblem(json ? write : writeError, failure.problem, json);
    return failure.exitCode;
  }
}

async function executeLocalTui(flags: CliFlags, options: ExecuteCliOptions): Promise<number> {
  assertInteractiveTty({
    stdinIsTTY: options.stdinIsTTY ?? process.stdin.isTTY === true,
    stdoutIsTTY: options.stdoutIsTTY ?? process.stdout.isTTY === true,
  });
  const explicitConfigPath = stringFlag(flags, "config");
  const paths = resolveLocalProjectPaths(
    options.workspace ?? process.cwd(),
    explicitConfigPath,
  );
  await assertPhysicallyConfinedLocalState(paths);
  if (explicitConfigPath !== undefined) {
    await assertWorkspaceOwnedLocalConfig(paths);
  }
  const inspect = options.inspectProjectState ?? inspectProjectState;
  const state = await inspect(paths);
  if (state === "partial") {
    throw new CliUsageError(
      "partial_project_state",
      "Project Agent State is incomplete and cannot be initialized automatically.",
    );
  }
  if (state === "absent") {
    const consent = await (options.prompt ?? createConsolePrompt()).confirm(
      `Initialize Project Agent State at ${paths.root}?`,
    );
    if (!consent) {
      throw new CliUsageError(
        "project_initialization_declined",
        "Project Agent State initialization was not approved.",
      );
    }
    await (options.initializeProjectState ?? initializeProjectState)(paths);
  }
  if (explicitConfigPath === undefined) {
    await assertWorkspaceOwnedLocalConfig(paths);
  }
  if (options.runLocalHost !== undefined) {
    return await options.runLocalHost({ configPath: paths.configPath, projectStateRoot: paths.root });
  }
  const { runLocalHost } = await import("../local/local-host.js");
  return await runLocalHost({ configPath: paths.configPath, projectStateRoot: paths.root });
}

async function assertWorkspaceOwnedLocalConfig(
  paths: LocalProjectPaths,
): Promise<void> {
  if (!(await isFile(paths.configPath))) {
    if (paths.configPath === path.join(paths.root, "myagent.yaml")) return;
    throw localConfigOutsideProjectState();
  }
  const config = await loadBootConfig(paths.configPath);
  const configDirectory = path.dirname(paths.configPath);
  const durablePaths = [
    path.resolve(configDirectory, config.database.path),
    ...config.agentRoots.map((root) => path.resolve(configDirectory, root)),
    ...config.skillRoots.map((root) => path.resolve(configDirectory, root)),
  ];
  if (durablePaths.some((candidate) => !isPathWithin(paths.root, candidate))) {
    throw localConfigOutsideProjectState();
  }
  await Promise.all(durablePaths.map((candidate) =>
    assertPhysicallyConfinedPath(paths.root, candidate)));
}

async function assertPhysicallyConfinedLocalState(
  paths: LocalProjectPaths,
): Promise<void> {
  try {
    const canonicalWorkspace = await canonicalizeExistingPath(paths.workspace);
    const canonicalRoot = await canonicalizeExistingPath(paths.root);
    if (!isPathWithin(canonicalWorkspace, canonicalRoot)) {
      throw localConfigOutsideProjectState();
    }
    await assertPhysicallyConfinedPath(paths.workspace, paths.root);
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    throw localConfigOutsideProjectState();
  }
}

interface LocalStateFilesystem {
  readonly lstat: (candidate: string) => Promise<unknown>;
  readonly realpath: (candidate: string) => Promise<string>;
  readonly stat: (candidate: string) => Promise<unknown>;
}

export async function assertPhysicallyConfinedPath(
  root: string,
  candidate: string,
  filesystem: LocalStateFilesystem = { lstat, realpath, stat },
): Promise<void> {
  const canonicalRoot = await canonicalizeExistingPath(root, filesystem.realpath);
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  let current = canonicalRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    const next = path.join(current, segment);
    try {
      await filesystem.lstat(next);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return;
      throw localConfigOutsideProjectState();
    }
    try {
      await filesystem.stat(next);
    } catch {
      throw localConfigOutsideProjectState();
    }
    try {
      current = await filesystem.realpath(next);
    } catch {
      throw localConfigOutsideProjectState();
    }
    if (!isPathWithin(canonicalRoot, current)) {
      throw localConfigOutsideProjectState();
    }
  }
}

async function canonicalizeExistingPath(
  candidate: string,
  resolveRealpath: (candidate: string) => Promise<string> = realpath,
): Promise<string> {
  let current = path.resolve(candidate);
  const missing: string[] = [];
  while (true) {
    try {
      const canonical = await resolveRealpath(current);
      return path.join(canonical, ...missing.reverse());
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function localConfigOutsideProjectState(): CliUsageError {
  return new CliUsageError(
    "local_config_outside_project_state",
    "Local configuration must use Workspace-owned Project Agent State.",
  );
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (
    !path.isAbsolute(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
  );
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}

function normalizeAttachedOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliUsageError("invalid_api_url", "The API URL must be an HTTP origin.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username.length > 0
    || url.password.length > 0
    || (url.pathname !== "/" && url.pathname !== "")
    || url.search.length > 0
    || url.hash.length > 0
  ) {
    throw new CliUsageError("invalid_api_url", "The API URL must be an HTTP origin.");
  }
  return new URL(url.origin);
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
    && octets[0] === "127";
}

function writeAttachedSummary(
  write: CliWrite,
  origin: URL,
  sources: { readonly run: string; readonly admin: string },
): void {
  write(`Origin: ${origin.origin}`);
  write(`TLS: ${origin.protocol === "https:" ? "enabled" : "disabled"}`);
  write(`Run credential source: ${sources.run}`);
  write(`Admin credential source: ${sources.admin}`);
}

type CliFlags = Readonly<Record<string, string | true>>;

class CliUsageError extends Error {
  readonly traceId = "cli";
  constructor(readonly code: string, readonly detail: string) { super(code); }
}

function parseArguments(argumentsList: readonly string[]): { positional: string[]; flags: CliFlags } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const switches = new Set([
    "json", "api-key-stdin", "allow-insecure-http", "manual-entry", "local", "allow-remote", "help",
  ]);
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]!;
    if (!argument.startsWith("--")) { positional.push(argument); continue; }
    const name = argument.slice(2);
    if (name === "api-key") throw new CliUsageError("visible_api_key_forbidden", "Use an environment reference or stdin for API keys.");
    if (name.length === 0 || flags[name] !== undefined) throw new CliUsageError("invalid_cli_option", "A CLI option is invalid.");
    if (switches.has(name)) { flags[name] = true; continue; }
    const value = argumentsList[index + 1];
    if (value === undefined || value.startsWith("--")) throw new CliUsageError("missing_cli_option", "A required CLI option value is missing.");
    flags[name] = value;
    index += 1;
  }
  return { positional, flags };
}

async function providerAuth(flags: CliFlags, readStdin: () => Promise<string>): Promise<ProviderAuthInput> {
  const environmentName = stringFlag(flags, "api-key-env");
  const fromStdin = booleanFlag(flags, "api-key-stdin");
  if (environmentName !== undefined && fromStdin) throw new CliUsageError("credential_source_conflict", "Choose one API key source.");
  if (fromStdin) {
    const apiKey = (await readStdin()).replace(/[\r\n]+$/gu, "");
    if (apiKey.length === 0) throw new CliUsageError("api_key_required", "An API key is required on stdin.");
    return { type: "api_key", apiKey };
  }
  if (environmentName !== undefined) return { type: "environment", fromEnvironment: environmentName };
  if (stringFlag(flags, "auth") === "none") return { type: "none" };
  throw new CliUsageError("api_key_source_required", "Use --api-key-env or --api-key-stdin.");
}

function rejectVisibleApiKey(flags: CliFlags): void {
  if (flags["api-key"] !== undefined) throw new CliUsageError("visible_api_key_forbidden", "Use an environment reference or stdin for API keys.");
}

function requiredFlag(flags: CliFlags, name: string): string {
  const value = stringFlag(flags, name);
  if (value === undefined || value.length === 0) throw new CliUsageError("missing_cli_option", "A required CLI option is missing.");
  return value;
}

function stringFlag(flags: CliFlags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function booleanFlag(flags: CliFlags, name: string): boolean { return flags[name] === true; }

function revisionFlag(flags: CliFlags): number {
  const value = Number(requiredFlag(flags, "expected-revision"));
  if (!Number.isSafeInteger(value) || value < 0) throw new CliUsageError("invalid_expected_revision", "Expected revision must be a non-negative integer.");
  return value;
}

function positiveIntegerFlag(flags: CliFlags, name: string): number {
  const value = Number(requiredFlag(flags, name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new CliUsageError("invalid_cli_option", "A CLI option must be a positive integer.");
  return value;
}

function requiredEnvironment(value: string | undefined, code: string, detail: string): string {
  if (value === undefined || value.length === 0) throw new CliUsageError(code, detail);
  return value;
}

function oneOf<const T extends readonly string[]>(value: string, allowed: T): T[number] {
  if (allowed.includes(value)) return value as T[number];
  throw new CliUsageError("invalid_cli_option", "A CLI option has an invalid value.");
}

function providerSelection(flags: CliFlags):
  | { readonly kind: "openai" | "deepseek" | "openai_compatible" }
  | { readonly driverId: string } {
  const kind = stringFlag(flags, "kind");
  const driverId = stringFlag(flags, "driver");
  if ((kind === undefined) === (driverId === undefined)) {
    throw new CliUsageError("invalid_cli_option", "Choose one Provider Driver.");
  }
  return driverId === undefined
    ? { kind: oneOf(kind!, ["openai", "deepseek", "openai_compatible"] as const) }
    : { driverId };
}

function modelSelection(flags: CliFlags):
  | {
      readonly modelId: string;
      readonly protocol: "auto" | "chat_completions" | "responses";
    }
  | { readonly catalogCandidateId: string } {
  const modelId = stringFlag(flags, "model-id");
  const catalogCandidateId = stringFlag(flags, "catalog-candidate");
  if ((modelId === undefined) === (catalogCandidateId === undefined)) {
    throw new CliUsageError("invalid_cli_option", "Choose one Model source.");
  }
  if (catalogCandidateId !== undefined) {
    if (stringFlag(flags, "protocol") !== undefined || booleanFlag(flags, "manual-entry")) {
      throw new CliUsageError("invalid_cli_option", "Catalog models use server-resolved invocation data.");
    }
    return { catalogCandidateId };
  }
  return {
    modelId: modelId!,
    protocol: oneOf(
      requiredFlag(flags, "protocol"),
      ["auto", "chat_completions", "responses"] as const,
    ),
  };
}

function cliFailure(error: unknown): { exitCode: number; problem: CliProblemOutput } {
  if (error instanceof CliUsageError) return { exitCode: 2, problem: error };
  if (error instanceof InteractiveTtyRequiredError) return { exitCode: 2, problem: error };
  if (error instanceof TuiTokensMustDifferError) return { exitCode: 3, problem: error };
  if (error instanceof TuiCredentialRequiredError) return { exitCode: 3, problem: error };
  if (error instanceof CliValidationError) return { exitCode: 2, problem: error };
  if (error instanceof CliProtocolError) return { exitCode: 7, problem: error };
  if (error instanceof CliCredentialError) return { exitCode: 3, problem: error };
  if (error instanceof CliHttpError) {
    const problem = { code: error.code, detail: error.detail, traceId: error.traceId };
    if (error.status === 401 || error.status === 403) return { exitCode: 3, problem };
    if (error.status === 409) return { exitCode: 4, problem };
    if (PROVIDER_FAILURE_CODES.has(error.code)) return { exitCode: 5, problem };
    if (error.status >= 500) return { exitCode: 6, problem };
    return { exitCode: 2, problem };
  }
  return { exitCode: 6, problem: { code: "service_unavailable", detail: "The service could not be reached.", traceId: "cli" } };
}

const PROVIDER_FAILURE_CODES = new Set([
  "provider_auth_failed", "provider_unavailable", "provider_rate_limited",
  "model_not_found", "invocation_protocol_unsupported", "streaming_unsupported",
  "tool_call_unsupported", "model_protocol_error", "secret_locked",
]);

const RUN_FLAGS = ["api-url", "token", "json"] as const;
const ADMIN_FLAGS = ["api-url", "admin-token", "json"] as const;
const TUI_FLAGS = ["api-url", "local", "config", "allow-remote"] as const;
type CommandLifecycle = "public" | "deprecated" | "internal";

interface CommandDefinition {
  readonly positional: number;
  readonly flags: readonly string[];
  readonly lifecycle: CommandLifecycle;
  readonly authority?: "admin";
}

const COMMANDS: Readonly<Record<string, CommandDefinition>> = {
  serve: { positional: 1, flags: ["config"], lifecycle: "public" },
  doctor: { positional: 1, flags: ADMIN_FLAGS, lifecycle: "public", authority: "admin" },
  local: { positional: 0, flags: ["config"], lifecycle: "public" },
  tui: { positional: 1, flags: TUI_FLAGS, lifecycle: "public" },
  "config validate": { positional: 2, flags: ["config", "json"], lifecycle: "public" },
  backup: { positional: 2, flags: RUN_FLAGS, lifecycle: "public" },
  "config reload": { positional: 2, flags: RUN_FLAGS, lifecycle: "internal" },
  "agents list": { positional: 2, flags: RUN_FLAGS, lifecycle: "deprecated" },
  "run create": { positional: 2, flags: [...RUN_FLAGS, "agent", "session", "text"], lifecycle: "deprecated" },
  "run cancel": { positional: 3, flags: RUN_FLAGS, lifecycle: "deprecated" },
  "run watch": { positional: 3, flags: RUN_FLAGS, lifecycle: "deprecated" },
  "approvals list": { positional: 2, flags: RUN_FLAGS, lifecycle: "deprecated" },
  "approvals approve": { positional: 3, flags: RUN_FLAGS, lifecycle: "deprecated" },
  "approvals deny": { positional: 3, flags: RUN_FLAGS, lifecycle: "deprecated" },
  "tools reconcile": { positional: 3, flags: [...RUN_FLAGS, "as"], lifecycle: "internal" },
  "sessions list": { positional: 2, flags: [...RUN_FLAGS, "agent", "session"], lifecycle: "deprecated" },
  "sessions delete": { positional: 3, flags: RUN_FLAGS, lifecycle: "deprecated" },
  "model setup": { positional: 2, flags: ADMIN_FLAGS, lifecycle: "deprecated", authority: "admin" },
  "providers add": { positional: 2, flags: [...ADMIN_FLAGS, "slug", "display-name", "kind", "driver", "base-url", "auth", "api-key-env", "api-key-stdin", "allow-insecure-http", "protocol"], lifecycle: "deprecated", authority: "admin" },
  "providers update": { positional: 2, flags: [...ADMIN_FLAGS, "provider", "expected-revision", "driver", "display-name", "base-url", "auth", "api-key-env", "api-key-stdin", "allow-insecure-http", "protocol"], lifecycle: "deprecated", authority: "admin" },
  "providers list": { positional: 2, flags: ADMIN_FLAGS, lifecycle: "deprecated", authority: "admin" },
  "providers discover": { positional: 2, flags: [...ADMIN_FLAGS, "connection-revision", "expected-revision"], lifecycle: "deprecated", authority: "admin" },
  "providers promote": { positional: 2, flags: [...ADMIN_FLAGS, "provider", "connection-revision", "expected-revision"], lifecycle: "deprecated", authority: "admin" },
  "providers retire": { positional: 2, flags: [...ADMIN_FLAGS, "provider", "expected-revision"], lifecycle: "deprecated", authority: "admin" },
  "models create": { positional: 2, flags: [...ADMIN_FLAGS, "slug", "display-name", "connection-revision", "catalog-candidate", "model-id", "protocol", "max-input-tokens", "context-source", "manual-entry"], lifecycle: "deprecated", authority: "admin" },
  "models verify": { positional: 2, flags: [...ADMIN_FLAGS, "profile-revision", "expected-revision"], lifecycle: "deprecated", authority: "admin" },
  "models promote": { positional: 2, flags: [...ADMIN_FLAGS, "model", "profile-revision", "expected-revision"], lifecycle: "deprecated", authority: "admin" },
  "models list": { positional: 2, flags: ADMIN_FLAGS, lifecycle: "deprecated", authority: "admin" },
  "models retire": { positional: 2, flags: [...ADMIN_FLAGS, "model", "expected-revision"], lifecycle: "deprecated", authority: "admin" },
  "models set-default": { positional: 2, flags: [...ADMIN_FLAGS, "model", "expected-revision"], lifecycle: "deprecated", authority: "admin" },
  "agents set-model": { positional: 2, flags: [...ADMIN_FLAGS, "agent", "profile-revision", "expected-revision"], lifecycle: "deprecated", authority: "admin" },
  "verifications get": { positional: 2, flags: [...ADMIN_FLAGS, "verification"], lifecycle: "deprecated", authority: "admin" },
  "secrets rotate-master-key": { positional: 2, flags: [...ADMIN_FLAGS, "expected-revision"], lifecycle: "internal", authority: "admin" },
};

function commandName(positional: readonly string[]): string {
  return positional.length === 0
    ? "local"
    : positional[0] === "backup"
      ? "backup"
      : positional.slice(0, 2).join(" ");
}

function publicHelpCommands(): readonly string[] {
  return ["myagent", "tui", "serve", "config validate", "doctor", "backup"];
}

function assertCommandGrammar(command: string, positional: number, flags: CliFlags): CommandDefinition {
  const grammar = COMMANDS[command];
  if (grammar === undefined || positional !== grammar.positional) {
    throw new CliUsageError("invalid_cli_command", "The CLI command is invalid.");
  }
  if (command === "tui" && (flags.token !== undefined || flags["admin-token"] !== undefined)) {
    throw new CliUsageError("visible_tui_token_forbidden", "Use TUI environment variables or masked prompts for tokens.");
  }
  const allowed = new Set(grammar.flags);
  if (Object.keys(flags).some((flag) => !allowed.has(flag))) {
    throw new CliUsageError("invalid_cli_command", "The CLI command is invalid.");
  }
  return grammar;
}

function asOutcome(value: string): "succeeded" | "failed" | "retry" {
  return oneOf(value, ["succeeded", "failed", "retry"] as const);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

if (process.argv[1]?.endsWith("main.js")) {
  void executeCli(process.argv.slice(2)).then((exitCode) => { process.exitCode = exitCode; });
}
