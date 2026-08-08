import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it.skipIf(process.platform === "win32")(
    "confirms POSIX group disappearance after SIGKILL when the leader closed",
    async () => {
      const readyPath = path.join(workspace, "sigterm-ignoring-descendant-ready");
      const sigtermPath = path.join(workspace, "sigterm-observed");
      const descendantScript = [
        "const { writeFileSync } = require('node:fs');",
        `process.on('SIGTERM', () => writeFileSync(${JSON.stringify(sigtermPath)}, 'observed'));`,
        `writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
        "setInterval(() => {}, 1000);",
      ].join(" ");
      const tree = ProcessTree.start(
        process.execPath,
        [
          "-e",
          [
            "const { spawn } = require('node:child_process');",
            "const { existsSync } = require('node:fs');",
            `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' });`,
            "descendant.unref();",
            `const readyPath = ${JSON.stringify(readyPath)};`,
            "const ready = setInterval(() => {",
            "  if (!existsSync(readyPath)) return;",
            "  clearInterval(ready);",
            "  console.log(descendant.pid);",
            "}, 10);",
          ].join(" "),
        ],
        { cwd: workspace, env: {} },
      );
      const descendantPid = Number(await firstLine(tree.child.stdout));
      await tree.wait();
      const startedAt = Date.now();

      try {
        await tree.terminate(100);

        expect(Date.now() - startedAt).toBeLessThan(600);
        expect(await readFile(sigtermPath, "utf8")).toBe("observed");
        expect(isProcessRunning(descendantPid)).toBe(false);
      } finally {
        if (isProcessRunning(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
          await expectProcessToExit(descendantPid);
        }
      }
    },
    5_000,
  );

  it("rejects an embedded NUL in the program before the target can launch", async () => {
    const markerPath = path.join(workspace, "nul-program-launched");
    const preloadPath = path.join(workspace, "nul-program-preload.cjs");
    await writeFile(
      preloadPath,
      `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "launched")`,
      "utf8",
    );

    let tree: ProcessTree | undefined;
    let failure: unknown;
    try {
      tree = ProcessTree.start(`${process.execPath}\0ignored`, [], {
        cwd: workspace,
        env: { NODE_OPTIONS: `--require=${preloadPath}` },
      });
      await tree.wait();
    } catch (error) {
      failure = error;
    } finally {
      if (tree !== undefined) await tree.terminate();
    }

    expect(failure).toMatchObject({ code: "invalid_process_argument" });
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an embedded NUL in argv before a truncated argument can run", async () => {
    const markerPath = path.join(workspace, "nul-argument-launched");
    const script = [
      "require('node:fs').writeFileSync(",
      `${JSON.stringify(markerPath)}, 'launched')`,
    ].join("");
    let tree: ProcessTree | undefined;
    let failure: unknown;
    try {
      tree = ProcessTree.start(
        process.execPath,
        ["-e", `${script}\0ignored`],
        { cwd: workspace, env: {} },
      );
      await tree.wait();
    } catch (error) {
      failure = error;
    } finally {
      if (tree !== undefined) await tree.terminate();
    }

    expect(failure).toMatchObject({ code: "invalid_process_argument" });
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an embedded NUL in cwd at the process boundary", () => {
    expect(() => ProcessTree.start(process.execPath, [], {
      cwd: `${workspace}\0ignored`,
      env: {},
    })).toThrow(expect.objectContaining({
      code: "invalid_process_argument",
      message: "invalid_process_argument",
    }));
  });

  it.skipIf(process.platform !== "win32").each([
    {
      boundary: "environment name",
      env: { "SAFE\0INJECTED": "owned" },
    },
    {
      boundary: "environment value",
      env: { SAFE: "safe\0INJECTED=owned" },
    },
  ])(
    "rejects a Windows $boundary NUL before an injected target can launch",
    async ({ env }) => {
      const markerPath = path.join(workspace, "environment-nul-injected");
      const script = [
        "if (process.env.INJECTED === 'owned')",
        `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'injected')`,
      ].join(" ");
      let tree: ProcessTree | undefined;
      let failure: unknown;
      try {
        tree = ProcessTree.start(process.execPath, ["-e", script], {
          cwd: workspace,
          env,
        });
        await tree.wait();
      } catch (error) {
        failure = error;
      } finally {
        if (tree !== undefined) await tree.terminate();
      }

      await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(failure).toMatchObject({
        code: "invalid_process_argument",
        message: "invalid_process_argument",
      });
      expect(String(failure)).not.toContain("owned");
      expect(JSON.stringify(failure)).not.toContain("owned");
    },
    10_000,
  );

  it.skipIf(process.platform !== "win32")(
    "rejects the reserved Windows bridge environment key case-insensitively",
    async () => {
      let tree: ProcessTree | undefined;
      let failure: unknown;
      try {
        tree = ProcessTree.start(process.execPath, ["-e", ""], {
          cwd: workspace,
          env: { myagent_windows_job_host: "requested" },
        });
        await tree.wait();
      } catch (error) {
        failure = error;
      } finally {
        if (tree !== undefined) await tree.terminate();
      }

      expect(failure).toMatchObject({
        code: "invalid_process_argument",
        message: "invalid_process_argument",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "allows the Windows bridge environment name on POSIX",
    async () => {
      const tree = ProcessTree.start(
        process.execPath,
        ["-e", "console.log(process.env.MYAGENT_WINDOWS_JOB_HOST)"],
        {
          cwd: workspace,
          env: { MYAGENT_WINDOWS_JOB_HOST: "ordinary-posix-value" },
        },
      );

      expect(await firstLine(tree.child.stdout)).toBe("ordinary-posix-value");
      expect(await tree.wait()).toEqual({ exitCode: 0, signal: null });
    },
  );

  it.skipIf(process.platform !== "win32")(
    "rejects the reserved Windows bridge NUL before an injected target side effect",
    async () => {
      const markerPath = path.join(workspace, "bridge-environment-injected");
      const script = [
        "if (process.env.INJECTED === 'owned')",
        `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'injected')`,
      ].join(" ");
      let tree: ProcessTree | undefined;
      let failure: unknown;
      try {
        tree = ProcessTree.start(process.execPath, ["-e", script], {
          cwd: workspace,
          env: {
            MYAGENT_WINDOWS_JOB_HOST: "safe\0INJECTED=owned",
          },
        });
        await tree.wait();
      } catch (error) {
        failure = error;
      } finally {
        if (tree !== undefined) await tree.terminate();
      }

      expect(failure).toMatchObject({
        code: "invalid_process_argument",
        message: "invalid_process_argument",
      });
      expect(String(failure)).not.toContain("owned");
      expect(JSON.stringify(failure)).not.toContain("owned");
      await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
    10_000,
  );

  it.skipIf(process.platform !== "win32")(
    "deduplicates ambient environment keys before applying case-insensitive overrides",
    async () => {
      const markerPath = path.join(workspace, "environment-override.txt");
      const requestedValue = "requested-environment-value";
      const originalEntries = Object.entries;
      const originalKeys = Object.keys;
      const entries = vi.spyOn(Object, "entries").mockImplementation(
        ((value: object) => {
          const result = originalEntries(value);
          return value === process.env
            ? [
                ...result,
                ["PATH", process.env.PATH ?? ""],
                ["Path", process.env.Path ?? ""],
              ]
            : result;
        }) as typeof Object.entries,
      );
      const keys = vi.spyOn(Object, "keys").mockImplementation(
        ((value: object) => {
          const result = originalKeys(value);
          return value === process.env
            ? [
                ...result,
                "MYAGENT_DUPLICATE_AMBIENT",
                "myagent_duplicate_ambient",
              ]
            : result;
        }) as typeof Object.keys,
      );
      try {
        const tree = ProcessTree.start(
          process.execPath,
          [
            "-e",
            [
              "require('node:fs').writeFileSync(",
              `${JSON.stringify(markerPath)}, JSON.stringify(process.env.MYAGENT_CASE_PROBE))`,
            ].join(""),
          ],
          {
            cwd: workspace,
            env: {
              MyAgent_Case_Probe: requestedValue,
            },
          },
        );
        const stderr = readStream(tree.child.stderr);

        const exit = await tree.wait();
        const failureOutput = await stderr;

        expect(exit).toEqual({ exitCode: 0, signal: null });
        expect(JSON.parse(await readFile(markerPath, "utf8"))).toBe(
          requestedValue,
        );
        expect(failureOutput).not.toContain(requestedValue);
      } finally {
        keys.mockRestore();
        entries.mockRestore();
      }
    },
    10_000,
  );

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

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
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
