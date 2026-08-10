#!/usr/bin/env node
import { CliClient, CliCredentialError, CliHttpError } from "./client.js";
import { listAgents, setAgentModel } from "./commands/agents.js";
import { listApprovals, decideApproval } from "./commands/approvals.js";
import { createBackup } from "./commands/backup.js";
import { reloadConfig, validateConfig } from "./commands/config.js";
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

export type { CliPrompt } from "./commands/model-setup.js";

export interface ExecuteCliOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  fetcher?: typeof fetch;
  prompt?: CliPrompt;
  readStdin?: () => Promise<string>;
  sleep?: (milliseconds: number) => Promise<void>;
  write?: CliWrite;
  writeError?: CliWrite;
}

export async function executeCli(argumentsList: readonly string[], options: ExecuteCliOptions = {}): Promise<number> {
  const environment = options.environment ?? process.env;
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeError = options.writeError ?? ((line: string) => process.stderr.write(`${line}\n`));
  let json = argumentsList.includes("--json");
  try {
    const { positional, flags } = parseArguments(argumentsList);
    json = booleanFlag(flags, "json");
    const command = positional[0] === "backup" ? "backup" : positional.slice(0, 2).join(" ");
    assertCommandGrammar(command, positional.length, flags);
    if (command === "serve") {
      await serve(stringFlag(flags, "config") ?? "myagent.yaml");
      return 0;
    }
    if (command === "config validate") {
      await validateConfig(stringFlag(flags, "config") ?? "myagent.yaml", write);
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
    if (ADMIN_COMMANDS.has(command) && (adminToken === undefined || adminToken.length === 0)) {
      throw new CliCredentialError("admin");
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
      await addProvider(client, {
        slug: requiredFlag(flags, "slug"),
        displayName: requiredFlag(flags, "display-name"),
        kind: oneOf(requiredFlag(flags, "kind"), ["openai", "deepseek", "openai_compatible"] as const),
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
      }, write);
      return 0;
    }
    if (command === "providers list") { await listProviders(client, write); return 0; }
    if (command === "providers discover") return await discoverProviderModels(client, requiredFlag(flags, "connection-revision"), revisionFlag(flags), write);
    if (command === "providers promote") { await promoteProvider(client, requiredFlag(flags, "provider"), requiredFlag(flags, "connection-revision"), revisionFlag(flags), write); return 0; }
    if (command === "providers retire") { await retireProvider(client, requiredFlag(flags, "provider"), revisionFlag(flags), write); return 0; }
    if (command === "models create") {
      await createModel(client, {
        slug: requiredFlag(flags, "slug"),
        displayName: requiredFlag(flags, "display-name"),
        connectionRevisionId: requiredFlag(flags, "connection-revision"),
        modelId: requiredFlag(flags, "model-id"),
        protocol: oneOf(requiredFlag(flags, "protocol"), ["auto", "chat_completions", "responses"] as const),
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
    if (command === "run cancel" && positional[2] !== undefined) { await cancelRun(client, positional[2], write); return 0; }
    if (command === "run watch" && positional[2] !== undefined) { await watchRun(client, positional[2], write); return 0; }
    if (command === "approvals list") { await listApprovals(client, write); return 0; }
    if (command === "approvals approve" && positional[2] !== undefined) { await decideApproval(client, positional[2], "approve", write); return 0; }
    if (command === "approvals deny" && positional[2] !== undefined) { await decideApproval(client, positional[2], "deny", write); return 0; }
    if (command === "tools reconcile" && positional[2] !== undefined) { await reconcileTool(client, positional[2], asOutcome(requiredFlag(flags, "as")), write); return 0; }
    if (command === "sessions list") { await listSessions(client, requiredFlag(flags, "agent"), requiredFlag(flags, "session"), write); return 0; }
    if (command === "sessions delete" && positional[2] !== undefined) { await deleteSession(client, positional[2], write); return 0; }
    if (command === "backup" && positional[1] !== undefined) { await createBackup(client, positional[1], write); return 0; }
    throw new CliUsageError("invalid_cli_command", "The CLI command is invalid.");
  } catch (error) {
    const failure = cliFailure(error);
    writeProblem(json ? write : writeError, failure.problem, json);
    return failure.exitCode;
  }
}

type CliFlags = Readonly<Record<string, string | true>>;

class CliUsageError extends Error {
  readonly traceId = "cli";
  constructor(readonly code: string, readonly detail: string) { super(code); }
}

function parseArguments(argumentsList: readonly string[]): { positional: string[]; flags: CliFlags } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const switches = new Set(["json", "api-key-stdin", "allow-insecure-http", "manual-entry"]);
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

function cliFailure(error: unknown): { exitCode: number; problem: CliProblemOutput } {
  if (error instanceof CliUsageError) return { exitCode: 2, problem: error };
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

const ADMIN_COMMANDS = new Set([
  "model setup",
  "providers add", "providers update", "providers list", "providers discover",
  "providers promote", "providers retire",
  "models create", "models verify", "models promote", "models list",
  "models retire", "models set-default",
  "agents set-model", "verifications get", "secrets rotate-master-key",
]);

const RUN_FLAGS = ["api-url", "token", "json"] as const;
const ADMIN_FLAGS = ["api-url", "admin-token", "json"] as const;
const COMMAND_GRAMMAR: Readonly<Record<string, {
  readonly positional: number;
  readonly flags: readonly string[];
}>> = {
  serve: { positional: 1, flags: ["config"] },
  "config validate": { positional: 2, flags: ["config", "json"] },
  "config reload": { positional: 2, flags: RUN_FLAGS },
  "agents list": { positional: 2, flags: RUN_FLAGS },
  "run create": { positional: 2, flags: [...RUN_FLAGS, "agent", "session", "text"] },
  "run cancel": { positional: 3, flags: RUN_FLAGS },
  "run watch": { positional: 3, flags: RUN_FLAGS },
  "approvals list": { positional: 2, flags: RUN_FLAGS },
  "approvals approve": { positional: 3, flags: RUN_FLAGS },
  "approvals deny": { positional: 3, flags: RUN_FLAGS },
  "tools reconcile": { positional: 3, flags: [...RUN_FLAGS, "as"] },
  "sessions list": { positional: 2, flags: [...RUN_FLAGS, "agent", "session"] },
  "sessions delete": { positional: 3, flags: RUN_FLAGS },
  backup: { positional: 2, flags: RUN_FLAGS },
  "model setup": { positional: 2, flags: ADMIN_FLAGS },
  "providers add": { positional: 2, flags: [...ADMIN_FLAGS, "slug", "display-name", "kind", "base-url", "auth", "api-key-env", "api-key-stdin", "allow-insecure-http", "protocol"] },
  "providers update": { positional: 2, flags: [...ADMIN_FLAGS, "provider", "expected-revision", "display-name", "base-url", "auth", "api-key-env", "api-key-stdin", "allow-insecure-http", "protocol"] },
  "providers list": { positional: 2, flags: ADMIN_FLAGS },
  "providers discover": { positional: 2, flags: [...ADMIN_FLAGS, "connection-revision", "expected-revision"] },
  "providers promote": { positional: 2, flags: [...ADMIN_FLAGS, "provider", "connection-revision", "expected-revision"] },
  "providers retire": { positional: 2, flags: [...ADMIN_FLAGS, "provider", "expected-revision"] },
  "models create": { positional: 2, flags: [...ADMIN_FLAGS, "slug", "display-name", "connection-revision", "model-id", "protocol", "max-input-tokens", "context-source", "manual-entry"] },
  "models verify": { positional: 2, flags: [...ADMIN_FLAGS, "profile-revision", "expected-revision"] },
  "models promote": { positional: 2, flags: [...ADMIN_FLAGS, "model", "profile-revision", "expected-revision"] },
  "models list": { positional: 2, flags: ADMIN_FLAGS },
  "models retire": { positional: 2, flags: [...ADMIN_FLAGS, "model", "expected-revision"] },
  "models set-default": { positional: 2, flags: [...ADMIN_FLAGS, "model", "expected-revision"] },
  "agents set-model": { positional: 2, flags: [...ADMIN_FLAGS, "agent", "profile-revision", "expected-revision"] },
  "verifications get": { positional: 2, flags: [...ADMIN_FLAGS, "verification"] },
  "secrets rotate-master-key": { positional: 2, flags: [...ADMIN_FLAGS, "expected-revision"] },
};

function assertCommandGrammar(command: string, positional: number, flags: CliFlags): void {
  const grammar = COMMAND_GRAMMAR[command];
  if (grammar === undefined || positional !== grammar.positional) {
    throw new CliUsageError("invalid_cli_command", "The CLI command is invalid.");
  }
  const allowed = new Set(grammar.flags);
  if (Object.keys(flags).some((flag) => !allowed.has(flag))) {
    throw new CliUsageError("invalid_cli_command", "The CLI command is invalid.");
  }
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
