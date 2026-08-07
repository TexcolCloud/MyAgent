import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

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
