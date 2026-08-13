import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRunCommandTool } from "../../src/adapters/tools/run-command.js";
import type { ProcessTree } from "../../src/adapters/tools/process-tree.js";
import { EnvironmentSecretResolver } from "../../src/adapters/environment-secret-resolver.js";
import type { AgentRevisionSnapshot } from "../../src/domain/agent-revision.js";
import {
  parseAgentId,
  runIdFromUuid,
  toolCallIdFromUuid,
} from "../../src/domain/ids.js";
import type { JsonValue } from "../../src/domain/json.js";
import { DEFAULT_RUN_LIMITS } from "../../src/domain/limits.js";
import {
  TEST_MODEL_PROFILE_REVISION_ID,
  testModelRuntime,
} from "../helpers/model-fixtures.js";
import type {
  ToolExecutionContext,
  ToolNormalizeContext,
} from "../../src/ports/tool.js";

const NORMAL_COMMAND_TIMEOUT_MS = 10_000;

describe("run_command Tool", () => {
  let workspace: string;
  let normalizeContext: ToolNormalizeContext;
  let executionContext: ToolExecutionContext;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), "myagent-run-command-"));
    const revision = revisionFor(workspace);
    normalizeContext = { agentId: revision.agentId, revision };
    executionContext = {
      ...normalizeContext,
      runId: runIdFromUuid("00000000-0000-7000-8000-000000000001"),
      toolCallId: toolCallIdFromUuid(
        "00000000-0000-7000-8000-000000000001",
      ),
      signal: new AbortController().signal,
      leaseOwner: "test-worker",
      remainingRunOutputBytes: DEFAULT_RUN_LIMITS.maxRunToolOutputBytes,
      activateSkill() {},
    };
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("passes shell metacharacters as literal arguments", async () => {
    const tool = createRunCommandTool({
      environmentAllowlist: [],
      secretResolver: new EnvironmentSecretResolver({}),
    });
    const normalized = await tool.parseAndNormalize(
      {
        program: process.execPath,
        args: ["-e", "console.log(process.argv[1])", "a && echo injected"],
        cwd: ".",
        env: {},
        timeoutMs: NORMAL_COMMAND_TIMEOUT_MS,
      },
      normalizeContext,
    );

    const result = await tool.execute(normalized.arguments, executionContext);

    expect(result.content).toMatchObject({
      exitCode: 0,
      stdout: "a && echo injected\n",
      stderr: "",
    });
  }, NORMAL_COMMAND_TIMEOUT_MS);

  it("rejects an embedded NUL in the approved program during normalization", async () => {
    const tool = createRunCommandTool({
      environmentAllowlist: [],
      secretResolver: new EnvironmentSecretResolver({}),
    });

    await expect(tool.parseAndNormalize(
      {
        program: `${process.execPath}\0ignored`,
        args: [],
        cwd: ".",
        env: {},
        timeoutMs: NORMAL_COMMAND_TIMEOUT_MS,
      },
      normalizeContext,
    )).rejects.toMatchObject({ code: "invalid_tool_arguments" });
  });

  it("rejects an embedded NUL in approved argv during normalization", async () => {
    const tool = createRunCommandTool({
      environmentAllowlist: [],
      secretResolver: new EnvironmentSecretResolver({}),
    });

    await expect(tool.parseAndNormalize(
      {
        program: process.execPath,
        args: ["-e", "process.exit(0)\0ignored"],
        cwd: ".",
        env: {},
        timeoutMs: NORMAL_COMMAND_TIMEOUT_MS,
      },
      normalizeContext,
    )).rejects.toMatchObject({ code: "invalid_tool_arguments" });
  });

  it.each([
    {
      boundary: "environment name",
      environmentAllowlist: ["SAFE\0INJECTED"],
      env: { "SAFE\0INJECTED": { value: "owned" } },
    },
    {
      boundary: "literal environment value",
      environmentAllowlist: ["SAFE"],
      env: { SAFE: { value: "safe\0INJECTED=owned" } },
    },
  ])(
    "rejects an embedded NUL in an approved $boundary during normalization",
    async ({ environmentAllowlist, env }) => {
      const tool = createRunCommandTool({
        environmentAllowlist,
        secretResolver: new EnvironmentSecretResolver({}),
      });

      await expect(tool.parseAndNormalize(
        {
          program: process.execPath,
          args: [],
          cwd: ".",
          env,
          timeoutMs: NORMAL_COMMAND_TIMEOUT_MS,
        },
        normalizeContext,
      )).rejects.toMatchObject({
        code: "invalid_tool_arguments",
        message: "invalid_tool_arguments",
      });
    },
  );

  it.skipIf(process.platform !== "win32")(
    "rejects the reserved Windows bridge environment key case-insensitively",
    async () => {
      const tool = createRunCommandTool({
        environmentAllowlist: ["myagent_windows_job_host"],
        secretResolver: new EnvironmentSecretResolver({}),
      });

      await expect(tool.parseAndNormalize(
        {
          program: process.execPath,
          args: [],
          cwd: ".",
          env: { myagent_windows_job_host: { value: "requested" } },
          timeoutMs: NORMAL_COMMAND_TIMEOUT_MS,
        },
        normalizeContext,
      )).rejects.toMatchObject({
        code: "invalid_tool_arguments",
        message: "invalid_tool_arguments",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "allows the Windows bridge environment name on POSIX",
    async () => {
      const tool = createRunCommandTool({
        environmentAllowlist: ["MYAGENT_WINDOWS_JOB_HOST"],
        secretResolver: new EnvironmentSecretResolver({}),
      });

      const normalized = await tool.parseAndNormalize(
        {
          program: process.execPath,
          args: [],
          cwd: ".",
          env: { MYAGENT_WINDOWS_JOB_HOST: { value: "ordinary-posix-value" } },
          timeoutMs: NORMAL_COMMAND_TIMEOUT_MS,
        },
        normalizeContext,
      );

      expect(normalized.arguments.env).toEqual({
        MYAGENT_WINDOWS_JOB_HOST: { value: "ordinary-posix-value" },
      });
    },
  );

  it("rejects a Secret-backed environment NUL before the target launches", async () => {
    const markerPath = path.join(workspace, "secret-nul-launched");
    const secretValue = "safe\0INJECTED=owned";
    const tool = createRunCommandTool({
      environmentAllowlist: ["SAFE"],
      secretResolver: new EnvironmentSecretResolver({
        SOURCE_SECRET: secretValue,
      }),
      startProcess: () => {
        writeFileSync(markerPath, "launched", "utf8");
        throw new Error("launcher_called");
      },
    });
    const normalized = await tool.parseAndNormalize(
      {
        program: process.execPath,
        args: [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'launched')`,
        ],
        env: { SAFE: { fromEnvironment: "SOURCE_SECRET" } },
        timeoutMs: NORMAL_COMMAND_TIMEOUT_MS,
      },
      normalizeContext,
    );

    let failure: unknown;
    try {
      await tool.execute(normalized.arguments, executionContext);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "tool_execution_infrastructure_failed",
      message: "tool_execution_infrastructure_failed",
      startState: "never_started",
    });
    expect(String(failure)).not.toContain(secretValue);
    expect(JSON.stringify(failure)).not.toContain(secretValue);
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects command arguments outside the strict safety boundary", async () => {
    const tool = createRunCommandTool({
      environmentAllowlist: ["ALLOWED"],
      secretResolver: new EnvironmentSecretResolver({}),
    });
    const base = {
      program: process.execPath,
      args: [] as string[],
      cwd: ".",
      env: {},
      timeoutMs: 2_000,
    };
    const cases: Array<{
      input: JsonValue;
      code?: string;
    }> = [
      { input: { ...base, cwd: ".." }, code: "path_outside_workspace" },
      {
        input: { ...base, env: { FORBIDDEN: { value: "x" } } },
        code: "environment_not_allowed",
      },
      { input: { ...base, timeoutMs: 600_001 } },
      { input: { ...base, shell: true } },
    ];

    for (const testCase of cases) {
      const rejection = expect(
        tool.parseAndNormalize(testCase.input, normalizeContext),
      ).rejects;
      if (testCase.code === undefined) {
        await rejection.toBeDefined();
      } else {
        await rejection.toMatchObject({ code: testCase.code });
      }
    }
  });

  it("uses the snapshotted Run timeout defaults and maximum", async () => {
    const revision = {
      ...normalizeContext.revision,
      limits: {
        ...normalizeContext.revision.limits,
        defaultToolTimeoutMs: 75,
        maxToolTimeoutMs: 100,
      },
    };
    const limitedContext = { agentId: revision.agentId, revision };
    const tool = createRunCommandTool({
      environmentAllowlist: [],
      secretResolver: new EnvironmentSecretResolver({}),
    });
    const normalized = await tool.parseAndNormalize(
      { program: process.execPath, args: [] },
      limitedContext,
    );

    expect(normalized.arguments.timeoutMs).toBe(75);
    await expect(
      tool.parseAndNormalize(
        { program: process.execPath, args: [], timeoutMs: 101 },
        limitedContext,
      ),
    ).rejects.toMatchObject({ code: "tool_timeout_exceeds_limit" });
  });

  it("resolves allowlisted environment references only during execution", async () => {
    const secretValue = "resolved-secret-value";
    const tool = createRunCommandTool({
      environmentAllowlist: ["DESTINATION_SECRET"],
      secretResolver: new EnvironmentSecretResolver({
        SOURCE_SECRET: secretValue,
      }),
    });
    const normalized = await tool.parseAndNormalize(
      {
        program: process.execPath,
        args: [
          "-e",
          [
            "const { createHash } = require('node:crypto');",
            "console.log(createHash('sha256').update(process.env.DESTINATION_SECRET ?? '').digest('hex'));",
            "console.log(process.env.PATH ? 'inherited' : 'isolated');",
          ].join(" "),
        ],
        env: {
          DESTINATION_SECRET: { fromEnvironment: "SOURCE_SECRET" },
        },
        timeoutMs: NORMAL_COMMAND_TIMEOUT_MS,
      },
      normalizeContext,
    );

    expect(JSON.stringify(normalized.arguments)).not.toContain(secretValue);
    expect(normalized.arguments.env).toEqual({
      DESTINATION_SECRET: { fromEnvironment: "SOURCE_SECRET" },
    });

    const result = await tool.execute(normalized.arguments, executionContext);

    expect(result.content).toMatchObject({
      exitCode: 0,
      stdout: `${sha256(secretValue)}\nisolated\n`,
      stderr: "",
    });
  });

  it("redacts resolved environment Secrets from captured output", async () => {
    const secretValue = "provider-secret-value";
    const tool = createRunCommandTool({
      environmentAllowlist: ["SECRET"],
      secretResolver: new EnvironmentSecretResolver({
        SOURCE_SECRET: secretValue,
      }),
    });
    const normalized = await tool.parseAndNormalize(
      {
        program: process.execPath,
        args: [
          "-e",
          "console.log(process.env.SECRET); console.error(process.env.SECRET)",
        ],
        env: { SECRET: { fromEnvironment: "SOURCE_SECRET" } },
        timeoutMs: NORMAL_COMMAND_TIMEOUT_MS,
      },
      normalizeContext,
    );

    const result = await tool.execute(normalized.arguments, executionContext);

    expect(JSON.stringify(result)).not.toContain(secretValue);
    expect(result.content).toMatchObject({
      stdout: "[REDACTED]\n",
      stderr: "[REDACTED]\n",
    });
  });

  it("caps retained output while continuing to drain both streams", async () => {
    const tool = createRunCommandTool({
      environmentAllowlist: [],
      secretResolver: new EnvironmentSecretResolver({}),
    });
    const bytesPerStream = 2 * 1_024 * 1_024;
    const normalized = await tool.parseAndNormalize(
      {
        program: process.execPath,
        args: [
          "-e",
          [
            `process.stdout.write('o'.repeat(${String(bytesPerStream)}));`,
            `process.stderr.write('e'.repeat(${String(bytesPerStream)}));`,
          ].join(" "),
        ],
        timeoutMs: NORMAL_COMMAND_TIMEOUT_MS,
      },
      normalizeContext,
    );

    const result = await tool.execute(normalized.arguments, {
      ...executionContext,
      remainingRunOutputBytes: 64,
    });
    const content = result.content as {
      exitCode: number | null;
      stdout: string;
      stderr: string;
      stdoutBytes: number;
      stderrBytes: number;
    };

    expect(content.exitCode).toBe(0);
    expect(content.stdoutBytes).toBe(bytesPerStream);
    expect(content.stderrBytes).toBe(bytesPerStream);
    expect(Buffer.byteLength(content.stdout) + Buffer.byteLength(content.stderr)).toBe(
      64,
    );
    expect(result.capturedBytes).toBe(64);
    expect(result.truncated).toBe(true);
  });

  it("bounds captured output after invalid bytes are converted to UTF-8", async () => {
    const tool = createRunCommandTool({
      environmentAllowlist: [],
      secretResolver: new EnvironmentSecretResolver({}),
    });
    const normalized = await tool.parseAndNormalize(
      {
        program: process.execPath,
        args: [
          "-e",
          "process.stdout.write(Buffer.alloc(64, 0x80))",
        ],
        timeoutMs: NORMAL_COMMAND_TIMEOUT_MS,
      },
      normalizeContext,
    );

    const result = await tool.execute(normalized.arguments, {
      ...executionContext,
      remainingRunOutputBytes: 64,
    });
    const content = result.content as { stdout: string; stderr: string };
    const returnedBytes =
      Buffer.byteLength(content.stdout) + Buffer.byteLength(content.stderr);

    expect(returnedBytes).toBeLessThanOrEqual(64);
    expect(result.capturedBytes).toBe(returnedBytes);
    expect(result.truncated).toBe(true);
  });

  it("bounds captured output after control bytes are escaped for persistence", async () => {
    const tool = createRunCommandTool({
      environmentAllowlist: [],
      secretResolver: new EnvironmentSecretResolver({}),
    });
    const normalized = await tool.parseAndNormalize(
      {
        program: process.execPath,
        args: [
          "-e",
          "process.stdout.write(Buffer.alloc(64, 0))",
        ],
        timeoutMs: NORMAL_COMMAND_TIMEOUT_MS,
      },
      normalizeContext,
    );

    const result = await tool.execute(normalized.arguments, {
      ...executionContext,
      remainingRunOutputBytes: 64,
    });
    const content = result.content as { stdout: string; stderr: string };
    const persistedOutputBytes =
      jsonStringPayloadBytes(content.stdout) +
      jsonStringPayloadBytes(content.stderr);

    expect(persistedOutputBytes).toBeLessThanOrEqual(64);
    expect(result.capturedBytes).toBe(persistedOutputBytes);
    expect(result.truncated).toBe(true);
  });

  it("terminates a command when its timeout expires", async () => {
    const tool = createRunCommandTool({
      environmentAllowlist: [],
      secretResolver: new EnvironmentSecretResolver({}),
    });
    const normalized = await tool.parseAndNormalize(
      {
        program: process.execPath,
        args: ["-e", "setTimeout(() => {}, 2_000)"],
        timeoutMs: 50,
      },
      normalizeContext,
    );
    const startedAt = Date.now();

    const result = await tool.execute(normalized.arguments, executionContext);

    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(result.ok).toBe(false);
    expect(result.content).toMatchObject({ timedOut: true, cancelled: false });
  }, 5_000);

  it("terminates descendants before propagating AbortSignal cancellation", async () => {
    const tool = createRunCommandTool({
      environmentAllowlist: [],
      secretResolver: new EnvironmentSecretResolver({}),
    });
    const normalized = await tool.parseAndNormalize(
      {
        program: process.execPath,
        args: [
          "-e",
          [
            "const { spawn } = require('node:child_process');",
            "const { writeFileSync } = require('node:fs');",
            "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
            "writeFileSync('descendant.pid', String(descendant.pid));",
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        timeoutMs: NORMAL_COMMAND_TIMEOUT_MS,
      },
      normalizeContext,
    );
    const controller = new AbortController();
    const execution = tool.execute(normalized.arguments, {
      ...executionContext,
      signal: controller.signal,
    });
    const descendantPid = Number(
      await waitForFile(path.join(workspace, "descendant.pid")),
    );

    controller.abort(new DOMException("run cancelled", "AbortError"));

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    await expectProcessToExit(descendantPid);
  }, 10_000);

  it("does not resolve Secrets or spawn after cancellation during cwd resolution", async () => {
    const tool = createRunCommandTool({
      environmentAllowlist: ["SECRET"],
      secretResolver: new EnvironmentSecretResolver({}),
    });
    const normalized = await tool.parseAndNormalize(
      {
        program: process.execPath,
        args: ["-e", "process.exit(99)"],
        env: { SECRET: { fromEnvironment: "MISSING_SECRET" } },
        timeoutMs: 2_000,
      },
      normalizeContext,
    );
    const controller = new AbortController();

    const execution = tool.execute(normalized.arguments, {
      ...executionContext,
      signal: controller.signal,
    });
    controller.abort(new DOMException("run cancelled", "AbortError"));

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
  });

  it("classifies a failure before process start as never started", async () => {
    const tool = createRunCommandTool({
      environmentAllowlist: ["SECRET"],
      secretResolver: new EnvironmentSecretResolver({}),
    });
    const normalized = await tool.parseAndNormalize(
      {
        program: process.execPath,
        args: ["-e", "process.exit(99)"],
        env: { SECRET: { fromEnvironment: "MISSING_SECRET" } },
        timeoutMs: 2_000,
      },
      normalizeContext,
    );

    await expect(tool.execute(normalized.arguments, executionContext))
      .rejects.toMatchObject({
        code: "tool_execution_infrastructure_failed",
        startState: "never_started",
      });
  });

  it("classifies a wait failure after process start as possibly started", async () => {
    const infrastructureFailure = new Error("simulated_wait_failure");
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const tool = createRunCommandTool({
      environmentAllowlist: [],
      secretResolver: new EnvironmentSecretResolver({}),
      startProcess: () => ({
        child: { stdout, stderr },
        wait: () => Promise.reject(infrastructureFailure),
        terminate: () => Promise.resolve(),
      }) as unknown as ProcessTree,
    });
    const normalized = await tool.parseAndNormalize(
      {
        program: process.execPath,
        args: ["-e", "process.exit(0)"],
        timeoutMs: 2_000,
      },
      normalizeContext,
    );

    await expect(tool.execute(normalized.arguments, executionContext))
      .rejects.toMatchObject({
        code: "tool_execution_infrastructure_failed",
        startState: "possibly_started",
      });
  });
});

function revisionFor(workspace: string): AgentRevisionSnapshot {
  const agentId = parseAgentId("primary");
  return {
    revisionId: "rev_run_command",
    definitionRevisionId: "def_run_command",
    modelProfileRevisionId: TEST_MODEL_PROFILE_REVISION_ID,
    agentId,
    displayName: "Primary",
    prompt: "Primary Agent",
    model: testModelRuntime(),
    workspace,
    skills: [],
    policy: [],
    delegates: [],
    limits: DEFAULT_RUN_LIMITS,
    contentSha256: "0".repeat(64),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function jsonStringPayloadBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
}

async function waitForFile(filePath: string): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT") || Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
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
