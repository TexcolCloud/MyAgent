import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProcessTree } from "../../src/adapters/tools/process-tree.js";

describe("ProcessTree", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), "myagent-process-tree-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("terminates the complete descendant process tree", async () => {
    const tree = ProcessTree.start(
      process.execPath,
      [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
          "console.log(descendant.pid);",
          "setInterval(() => {}, 1000);",
        ].join(" "),
      ],
      { cwd: workspace, env: {} },
    );
    const descendantPid = Number(await firstLine(tree.child.stdout));
    expect(Number.isInteger(descendantPid)).toBe(true);
    const close = tree.wait();

    await tree.terminate(100);

    const exit = await close;
    expect(exit.exitCode !== null || exit.signal !== null).toBe(true);
    await expectProcessToExit(descendantPid);
  }, 10_000);

  it("treats an already-exited process as terminated", async () => {
    const tree = ProcessTree.start(process.execPath, ["-e", ""], {
      cwd: workspace,
      env: {},
    });
    await tree.wait();

    await expect(tree.terminate()).resolves.toBeUndefined();
  });

  it.skipIf(process.platform !== "win32")(
    "assigns the target before an immediate descendant can escape the Job",
    async () => {
      const launcherPath = path.join(workspace, "spawn-immediately.cmd");
      const pidPath = path.join(workspace, "immediate-descendant.pid");
      const descendantScript = [
        "const { writeFileSync } = require('node:fs');",
        `writeFileSync('${pidPath.replaceAll("\\", "/")}', String(process.pid));`,
        "setInterval(() => {}, 1000);",
      ].join(" ");
      await writeFile(
        launcherPath,
        [
          "@echo off",
          `start "" /b "${process.execPath}" -e "${descendantScript}"`,
          ":wait_for_pid",
          `if not exist "${pidPath}" goto wait_for_pid`,
          ":wait_for_termination",
          "%SystemRoot%\\System32\\ping.exe -n 2 127.0.0.1 >nul",
          "goto wait_for_termination",
        ].join("\r\n"),
        "utf8",
      );
      const command = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
      const tree = ProcessTree.start(command, ["/d", "/c", launcherPath], {
        cwd: workspace,
        env: {},
      });
      const descendantPid = Number(await waitForFile(pidPath));
      expect(Number.isInteger(descendantPid)).toBe(true);

      const termination = tree.terminate(100).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      const escaped = isProcessRunning(descendantPid);
      if (escaped) process.kill(descendantPid, "SIGKILL");
      const terminated = await termination;
      if (!terminated.ok) throw terminated.error;

      expect(escaped).toBe(false);
    },
    10_000,
  );

  it.skipIf(process.platform !== "win32")(
    "treats process exit before inherited pipes close as already exited",
    async () => {
      const tree = ProcessTree.start(
        process.execPath,
        [
          "-e",
          [
            "const { spawn } = require('node:child_process');",
            "const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 750)'], { detached: true, stdio: ['ignore', 1, 2] });",
            "descendant.unref();",
            "console.log(descendant.pid);",
          ].join(" "),
        ],
        { cwd: workspace, env: {} },
      );
      const parentExit = once(tree.child, "exit");
      const descendantPid = Number(await firstLine(tree.child.stdout));
      await parentExit;

      try {
        await expect(tree.terminate(100)).resolves.toBeUndefined();
        expect(isProcessRunning(descendantPid)).toBe(false);
      } finally {
        await expectProcessToExit(descendantPid);
      }
    },
    10_000,
  );
});

async function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
  const lines = createInterface({ input: stream });
  try {
    for await (const line of lines) {
      return line;
    }
    throw new Error("process closed without emitting a line");
  } finally {
    lines.close();
  }
}

async function expectProcessToExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (isProcessRunning(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`process ${String(pid)} is still running`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForFile(filePath: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (
        typeof error !== "object" || error === null ||
        !("code" in error) || error.code !== "ENOENT" ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}
