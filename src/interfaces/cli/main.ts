#!/usr/bin/env node
import { CliClient } from "./client.js";
import { listAgents } from "./commands/agents.js";
import { listApprovals, decideApproval } from "./commands/approvals.js";
import { createBackup } from "./commands/backup.js";
import { reloadConfig, validateConfig } from "./commands/config.js";
import { createRun, cancelRun, watchRun } from "./commands/runs.js";
import { serve } from "./commands/serve.js";
import { deleteSession, listSessions } from "./commands/sessions.js";
import { reconcileTool } from "./commands/tools.js";
import type { CliWrite } from "./formatters.js";

export interface ExecuteCliOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  fetcher?: typeof fetch;
  write?: CliWrite;
}

export async function executeCli(argumentsList: readonly string[], options: ExecuteCliOptions = {}): Promise<void> {
  const environment = options.environment ?? process.env;
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const { positional, flags } = parseArguments(argumentsList);
  const command = positional[0] === "backup" ? "backup" : positional.slice(0, 2).join(" ");
  if (command === "serve") return serve(flags.config ?? "myagent.yaml");
  if (command === "config validate") return validateConfig(flags.config ?? "myagent.yaml", write);

  const client = new CliClient({
    baseUrl: flags["api-url"] ?? required(environment.MYAGENT_API_URL, "MYAGENT_API_URL"),
    bearerToken: flags.token ?? required(environment.MYAGENT_BEARER_TOKEN, "MYAGENT_BEARER_TOKEN"),
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
  });
  if (command === "config reload") return reloadConfig(client, write);
  if (command === "agents list") return listAgents(client, write);
  if (command === "run create") return createRun(client, { agentId: required(flags.agent, "--agent"), sessionKey: required(flags.session, "--session"), text: required(flags.text, "--text") }, write);
  if (command === "run cancel" && positional[2] !== undefined) return cancelRun(client, positional[2], write);
  if (command === "run watch" && positional[2] !== undefined) return watchRun(client, positional[2], write);
  if (command === "approvals list") return listApprovals(client, write);
  if (command === "approvals approve" && positional[2] !== undefined) return decideApproval(client, positional[2], "approve", write);
  if (command === "approvals deny" && positional[2] !== undefined) return decideApproval(client, positional[2], "deny", write);
  if (command === "tools reconcile" && positional[2] !== undefined) return reconcileTool(client, positional[2], asOutcome(required(flags.as, "--as")), write);
  if (command === "sessions list") return listSessions(client, required(flags.agent, "--agent"), required(flags.session, "--session"), write);
  if (command === "sessions delete" && positional[2] !== undefined) return deleteSession(client, positional[2], write);
  if (command === "backup" && positional[1] !== undefined) return createBackup(client, positional[1], write);
  throw new Error("invalid_cli_command");
}

function parseArguments(argumentsList: readonly string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = []; const flags: Record<string, string> = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]!;
    if (!argument.startsWith("--")) { positional.push(argument); continue; }
    const name = argument.slice(2); const value = argumentsList[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing_cli_option_${name}`);
    flags[name] = value; index += 1;
  }
  return { positional, flags };
}

function required(value: string | undefined, name: string): string { if (value === undefined || value.length === 0) throw new Error(`missing_cli_option_${name}`); return value; }
function asOutcome(value: string): "succeeded" | "failed" | "retry" { if (value === "succeeded" || value === "failed" || value === "retry") return value; throw new Error("invalid_reconciliation_outcome"); }

if (process.argv[1]?.endsWith("main.js")) {
  executeCli(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "cli_failed"}\n`); process.exitCode = 1; });
}
