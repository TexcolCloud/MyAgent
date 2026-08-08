import path from "node:path";

import { z } from "zod";

import {
  toolEnvironmentValueSchema,
  type ToolEnvironmentValue,
} from "../../config/secret-ref.js";
import { DomainError } from "../../domain/errors.js";
import {
  ToolExecutionError,
  type ToolDefinition,
} from "../../ports/tool.js";
import type { SecretResolver } from "../../ports/secret-resolver.js";
import { PathGuard } from "./path-guard.js";
import {
  ProcessTree,
  type ProcessExit,
} from "./process-tree.js";

const MAX_TOOL_OUTPUT_BYTES = 1_024 * 1_024;
const WINDOWS_JOB_HOST_ENVIRONMENT = "myagent_windows_job_host";

const commandSchema = z.strictObject({
  program: z.string().min(1),
  args: z.array(z.string()).max(256),
  cwd: z.string().default("."),
  env: z.record(z.string(), toolEnvironmentValueSchema).default({}),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
});

type RunCommandArguments = {
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, ToolEnvironmentValue>;
  timeoutMs: number;
};

export interface RunCommandToolOptions {
  environmentAllowlist: readonly string[];
  secretResolver: SecretResolver;
  startProcess?: typeof ProcessTree.start;
}

export function createRunCommandTool(
  options: RunCommandToolOptions,
): ToolDefinition<RunCommandArguments> {
  const allowedEnvironment = new Set(options.environmentAllowlist);
  const startProcess = options.startProcess ?? ProcessTree.start;
  return {
    name: "run_command",
    effect: "side_effect",

    async parseAndNormalize(raw, context) {
      const parsed = commandSchema.parse(raw);
      if (
        parsed.program.includes("\0") ||
        parsed.args.some((argument) => argument.includes("\0"))
      ) {
        throw new DomainError("invalid_tool_arguments");
      }
      await new PathGuard(context.revision.workspace).resolveExisting(parsed.cwd);
      const timeoutMs =
        parsed.timeoutMs ?? context.revision.limits.defaultToolTimeoutMs;
      if (
        timeoutMs >
        Math.min(600_000, context.revision.limits.maxToolTimeoutMs)
      ) {
        throw new DomainError("tool_timeout_exceeds_limit");
      }
      for (const [name, value] of Object.entries(parsed.env)) {
        if (
          name.includes("\0") ||
          ("value" in value && value.value.includes("\0")) ||
          isReservedWindowsEnvironmentName(name)
        ) {
          throw new DomainError("invalid_tool_arguments");
        }
        if (!allowedEnvironment.has(name)) {
          throw new DomainError("environment_not_allowed");
        }
      }
      return {
        arguments: {
          ...parsed,
          cwd: portablePath(path.normalize(parsed.cwd)),
          timeoutMs,
        },
        policyFacts: { pathWithinWorkspace: true },
      };
    },

    async execute(args, context) {
      let tree: ProcessTree;
      let environment: ResolvedEnvironment;
      try {
        context.signal.throwIfAborted();
        const cwd = await new PathGuard(
          context.revision.workspace,
        ).resolveExisting(args.cwd);
        context.signal.throwIfAborted();
        environment = resolveEnvironment(args.env, options.secretResolver);
        validateResolvedEnvironment(environment.values);
        tree = startProcess(args.program, args.args, {
          cwd,
          env: environment.values,
        });
      } catch {
        if (context.signal.aborted) throw context.signal.reason;
        throw new ToolExecutionError("never_started");
      }

      try {
        const outputLimit = Math.min(
          MAX_TOOL_OUTPUT_BYTES,
          context.revision.limits.maxToolOutputBytes,
          Math.max(0, context.remainingRunOutputBytes),
        );
        const captureBudget = new RawCaptureBudget(outputLimit);
        const stdout = new StreamCapture(captureBudget);
        const stderr = new StreamCapture(captureBudget);
        tree.child.stdout.on("data", (chunk: Buffer) => stdout.accept(chunk));
        tree.child.stderr.on("data", (chunk: Buffer) => stderr.accept(chunk));
        const completion = await waitForCompletion(
          tree,
          args.timeoutMs,
          context.signal,
        );
        if (completion.cancelled) {
          context.signal.throwIfAborted();
        }
        const outputBudget = new OutputBudget(outputLimit);
        const content = {
          exitCode: completion.exit.exitCode,
          signal: completion.exit.signal,
          stdout: outputBudget.retain(
            redactKnownValues(stdout.text(), environment.sensitiveValues),
          ),
          stderr: outputBudget.retain(
            redactKnownValues(stderr.text(), environment.sensitiveValues),
          ),
          stdoutBytes: stdout.totalBytes,
          stderrBytes: stderr.totalBytes,
          timedOut: completion.timedOut,
          cancelled: completion.cancelled,
        };
        return {
          ok: completion.exit.exitCode === 0 && !completion.timedOut,
          summary: completion.timedOut
            ? "Command timed out."
            : `Command exited with code ${String(completion.exit.exitCode)}.`,
          content,
          capturedBytes: outputBudget.capturedBytes,
          truncated: captureBudget.truncated || outputBudget.truncated,
        };
      } catch {
        if (context.signal.aborted) throw context.signal.reason;
        throw new ToolExecutionError("possibly_started");
      }
    },
  };
}

interface ProcessCompletion {
  exit: ProcessExit;
  timedOut: boolean;
  cancelled: boolean;
}

async function waitForCompletion(
  tree: ProcessTree,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ProcessCompletion> {
  let timeout: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const interruption = new Promise<"timeout" | "cancelled">((resolve) => {
    timeout = setTimeout(() => resolve("timeout"), timeoutMs);
    onAbort = () => resolve("cancelled");
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });

  let outcome: ProcessExit | "timeout" | "cancelled";
  try {
    outcome = await Promise.race([tree.wait(), interruption]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }

  if (typeof outcome !== "string") {
    return { exit: outcome, timedOut: false, cancelled: false };
  }
  await tree.terminate();
  return {
    exit: await tree.wait(),
    timedOut: outcome === "timeout",
    cancelled: outcome === "cancelled",
  };
}

class RawCaptureBudget {
  #remainingBytes: number;
  truncated = false;

  constructor(limit: number) {
    this.#remainingBytes = limit;
  }

  retain(chunk: Buffer): Buffer | undefined {
    const retainedBytes = Math.min(this.#remainingBytes, chunk.length);
    if (retainedBytes < chunk.length) {
      this.truncated = true;
    }
    if (retainedBytes === 0) {
      return undefined;
    }
    this.#remainingBytes -= retainedBytes;
    return Buffer.from(chunk.subarray(0, retainedBytes));
  }
}

class StreamCapture {
  readonly #chunks: Buffer[] = [];
  totalBytes = 0;

  constructor(private readonly budget: RawCaptureBudget) {}

  accept(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    const retained = this.budget.retain(chunk);
    if (retained !== undefined) {
      this.#chunks.push(retained);
    }
  }

  text(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }
}

class OutputBudget {
  #remainingBytes: number;
  capturedBytes = 0;
  truncated = false;

  constructor(limit: number) {
    this.#remainingBytes = limit;
  }

  retain(text: string): string {
    const textBytes = jsonStringPayloadBytes(text);
    if (textBytes <= this.#remainingBytes) {
      this.#remainingBytes -= textBytes;
      this.capturedBytes += textBytes;
      return text;
    }

    this.truncated = true;
    let retainedBytes = 0;
    let retainedCharacters = 0;
    for (const character of text) {
      const characterBytes = jsonStringPayloadBytes(character);
      if (retainedBytes + characterBytes > this.#remainingBytes) {
        break;
      }
      retainedBytes += characterBytes;
      retainedCharacters += character.length;
    }
    this.#remainingBytes -= retainedBytes;
    this.capturedBytes += retainedBytes;
    return text.slice(0, retainedCharacters);
  }
}

function jsonStringPayloadBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
}

interface ResolvedEnvironment {
  values: Record<string, string>;
  sensitiveValues: readonly string[];
}

function resolveEnvironment(
  environment: Readonly<Record<string, ToolEnvironmentValue>>,
  secretResolver: SecretResolver,
): ResolvedEnvironment {
  const values: Record<string, string> = {};
  const sensitiveValues = new Set<string>();
  for (const [name, value] of Object.entries(environment)) {
    if ("value" in value) {
      values[name] = value.value;
      continue;
    }
    const resolved = secretResolver.resolve(value);
    values[name] = resolved;
    sensitiveValues.add(resolved);
  }
  return { values, sensitiveValues: [...sensitiveValues] };
}

function validateResolvedEnvironment(
  environment: Readonly<Record<string, string>>,
): void {
  for (const [name, value] of Object.entries(environment)) {
    if (
      name.includes("\0") ||
      value.includes("\0") ||
      isReservedWindowsEnvironmentName(name)
    ) {
      throw new DomainError("invalid_process_argument");
    }
  }
}

function isReservedWindowsEnvironmentName(name: string): boolean {
  return process.platform === "win32" &&
    name.toLowerCase() === WINDOWS_JOB_HOST_ENVIRONMENT;
}

function redactKnownValues(
  text: string,
  sensitiveValues: readonly string[],
): string {
  return [...sensitiveValues]
    .sort((left, right) => right.length - left.length)
    .reduce(
      (redacted, value) => redacted.replaceAll(value, "[REDACTED]"),
      text,
    );
}

function portablePath(candidate: string): string {
  return candidate.split(path.sep).join("/");
}
