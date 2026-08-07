import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

import { DomainError } from "../../domain/errors.js";

export interface ProcessStartOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
}

export interface ProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export class ProcessTree {
  readonly #exit: Promise<ProcessExit>;
  #settled = false;
  #termination: Promise<void> | undefined;

  private constructor(readonly child: ChildProcessWithoutNullStreams) {
    this.#exit = new Promise((resolve, reject) => {
      child.once("error", (error) => {
        this.#settled = true;
        reject(error);
      });
      child.once("close", (exitCode, signal) => {
        this.#settled = true;
        resolve({ exitCode, signal });
      });
    });
  }

  static start(
    program: string,
    args: readonly string[],
    options: ProcessStartOptions,
  ): ProcessTree {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: isolatedEnvironment(options.env),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    child.stdin.end();
    return new ProcessTree(child);
  }

  wait(): Promise<ProcessExit> {
    return this.#exit;
  }

  terminate(graceMs = 1_000): Promise<void> {
    this.#termination ??= this.#terminate(graceMs);
    return this.#termination;
  }

  async #terminate(graceMs: number): Promise<void> {
    if (this.#settled) {
      await this.#exit;
      return;
    }
    const pid = this.child.pid;
    if (pid === undefined) {
      await this.#exit;
      return;
    }

    if (process.platform === "win32") {
      const exitCode = await terminateWindowsTree(pid);
      if (exitCode !== 0 && !this.#settled) {
        this.child.kill("SIGKILL");
        throw new DomainError("process_tree_termination_failed");
      }
    } else {
      signalProcessGroup(pid, "SIGTERM");
      if (await processGroupStillRunning(pid, graceMs)) {
        signalProcessGroup(pid, "SIGKILL");
      }
    }
    await this.#exit;
  }
}

async function terminateWindowsTree(pid: number): Promise<number | null> {
  const systemRoot =
    Object.entries(process.env).find(
      ([name]) => name.toLowerCase() === "systemroot",
    )?.[1] ?? "C:\\Windows";
  const taskkill = spawn(
    path.join(systemRoot, "System32", "taskkill.exe"),
    ["/PID", String(pid), "/T", "/F"],
    { shell: false, windowsHide: true, stdio: "ignore" },
  );
  return new Promise<number | null>((resolve, reject) => {
    taskkill.once("error", reject);
    taskkill.once("close", (exitCode) => resolve(exitCode));
  });
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!hasErrorCode(error, "ESRCH")) {
      throw error;
    }
  }
}

async function processGroupStillRunning(
  pid: number,
  graceMs: number,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, graceMs);
  while (isProcessGroupRunning(pid)) {
    if (Date.now() >= deadline) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function isProcessGroupRunning(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) {
      return false;
    }
    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function isolatedEnvironment(
  allowedValues: Readonly<Record<string, string>>,
): Record<string, string> {
  if (process.platform !== "win32") {
    return { ...allowedValues };
  }

  const environment = Object.fromEntries(
    Object.keys(process.env).map((name) => [name, ""]),
  );
  const systemRootName = Object.keys(process.env).find(
    (name) => name.toLowerCase() === "systemroot",
  );
  if (systemRootName !== undefined) {
    environment[systemRootName] = process.env[systemRootName] ?? "";
  }
  for (const [name, value] of Object.entries(allowedValues)) {
    for (const existingName of Object.keys(environment)) {
      if (existingName.toLowerCase() === name.toLowerCase()) {
        delete environment[existingName];
      }
    }
    environment[name] = value;
  }
  return environment;
}
