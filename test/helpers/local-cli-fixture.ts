import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { DatabaseSync } from "node:sqlite";

import { bootstrap, type BootstrapOptions } from "../../src/bootstrap.js";
import { executeCli } from "../../src/interfaces/cli/main.js";
import { runLocalHost } from "../../src/interfaces/local/local-host.js";
import type { RunWorkbenchOptions } from "../../src/interfaces/tui/workbench.js";

export interface LocalCliCapture {
  readonly exitCode: number;
  readonly urls: readonly string[];
  readonly listen: readonly NonNullable<BootstrapOptions["listen"]>[];
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  readonly logs: readonly string[];
  readonly consentPrompts: readonly string[];
  readonly unauthenticatedStatuses: readonly number[];
}

export interface LocalCliFixtureOptions {
  readonly workspace: string;
  readonly tokens?: readonly [runToken: string, adminToken: string];
  readonly onTui?: (options: RunWorkbenchOptions) => Promise<void>;
}

export interface CapturedTextSurface {
  readonly name: string;
  readonly text: string;
}

export interface ExactTokenGenerator {
  next(): string;
  assertConsumed(): void;
}

export function createExactTokenGenerator(
  values: readonly [runToken: string, adminToken: string],
): ExactTokenGenerator {
  const remaining = [...values];
  return {
    next(): string {
      const token = remaining.shift();
      if (token === undefined) throw new Error("local_fixture_token_exhausted");
      return token;
    },
    assertConsumed(): void {
      if (remaining.length !== 0) throw new Error("local_fixture_tokens_not_consumed");
    },
  };
}

export async function runLocalCliFixture(
  options: LocalCliFixtureOptions,
): Promise<LocalCliCapture> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logs: string[] = [];
  const urls: string[] = [];
  const listen: NonNullable<BootstrapOptions["listen"]>[] = [];
  const consentPrompts: string[] = [];
  const unauthenticatedStatuses: number[] = [];
  const generatedTokens = options.tokens === undefined
    ? undefined
    : createExactTokenGenerator(options.tokens);

  const exitCode = await executeCli([], {
    workspace: options.workspace,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    write: (line) => { stdout.push(line); },
    writeError: (line) => { stderr.push(line); },
    prompt: {
      select: async () => { throw new Error("local_fixture_unexpected_select"); },
      confirm: async (message) => {
        consentPrompts.push(message);
        return true;
      },
      input: async () => "",
      secret: async () => "",
    },
    runLocalHost: async ({ configPath }) => runLocalHost({
      configPath,
      dependencies: {
        ...(generatedTokens === undefined
          ? {}
          : { generateToken: () => generatedTokens.next() }),
        bootstrapService: async (capturedConfigPath, bootstrapOptions = {}) => {
          if (bootstrapOptions.listen !== undefined) listen.push(bootstrapOptions.listen);
          const service = await bootstrap(capturedConfigPath, {
            ...bootstrapOptions,
            log: { write: (line) => { logs.push(line); } },
          });
          urls.push(service.url);
          unauthenticatedStatuses.push((await fetch(`${service.url}/v1/agents`)).status);
          return service;
        },
        runTui: async (workbenchOptions) => {
          await workbenchOptions.client.listAgents();
          await options.onTui?.(workbenchOptions);
          return 0;
        },
      },
    }),
  });
  generatedTokens?.assertConsumed();

  return {
    exitCode,
    urls,
    listen,
    stdout,
    stderr,
    logs,
    consentPrompts,
    unauthenticatedStatuses,
  };
}

export async function captureProjectTextSurfaces(
  projectRoot: string,
  databasePath: string,
): Promise<readonly CapturedTextSurface[]> {
  const files = await collectFiles(projectRoot);
  const fileSurfaces = await Promise.all(files.map(async (filePath) => ({
    name: path.relative(projectRoot, filePath),
    text: (await readFile(filePath)).toString("latin1"),
  })));
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    const projection = tables.map(({ name }) => ({
      table: name,
      rows: database.prepare(`SELECT * FROM ${quoteIdentifier(name)}`).all(),
    }));
    return [
      ...fileSurfaces,
      { name: "sqlite-text-projection", text: JSON.stringify(projection) },
    ];
  } finally {
    database.close();
  }
}

async function collectFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const candidate = path.join(root, entry.name);
    return entry.isDirectory() ? collectFiles(candidate) : [candidate];
  }));
  return nested.flat();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
