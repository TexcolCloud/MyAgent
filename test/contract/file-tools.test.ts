import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BoundedLexicalEntries,
  listFilesTool,
} from "../../src/adapters/tools/list-files.js";
import { readFileTool } from "../../src/adapters/tools/read-file.js";
import {
  installCreateOnly,
  preservedFileMode,
  TargetWriteCoordinator,
  writeFileTool,
} from "../../src/adapters/tools/write-file.js";
import type { AgentRevisionSnapshot } from "../../src/domain/agent-revision.js";
import {
  parseAgentId,
  runIdFromUuid,
  toolCallIdFromUuid,
} from "../../src/domain/ids.js";
import { DEFAULT_RUN_LIMITS } from "../../src/domain/limits.js";
import type {
  ToolExecutionContext,
  ToolNormalizeContext,
} from "../../src/ports/tool.js";

const KIBIBYTE = 1_024;
const MEBIBYTE = 1_024 * KIBIBYTE;

describe("Workspace file Tools", () => {
  let root: string;
  let workspace: string;
  let normalizeContext: ToolNormalizeContext;
  let executionContext: ToolExecutionContext;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "myagent-file-tools-"));
    workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const revision = revisionFor(workspace);
    normalizeContext = { agentId: revision.agentId, revision };
    executionContext = {
      ...normalizeContext,
      runId: runIdFromUuid("00000000-0000-7000-8000-000000000001"),
      toolCallId: toolCallIdFromUuid(
        "00000000-0000-7000-8000-000000000001",
      ),
      signal: new AbortController().signal,
      remainingRunOutputBytes: 8 * MEBIBYTE,
      activateSkill() {},
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("retains only a bounded lexical prefix while scanning", () => {
    const entries = new BoundedLexicalEntries<ListedEntry>(2);

    for (const entryPath of ["z.txt", "b.txt", "a.txt", "c.txt"]) {
      entries.add({ path: entryPath, type: "file", size: 1 });
    }

    expect(entries.values().map((entry) => entry.path)).toEqual([
      "a.txt",
      "b.txt",
    ]);
    expect(entries.values()).toHaveLength(2);
    expect(entries.truncated).toBe(true);
  });

  it("lists relative metadata in lexical order with default and hard caps", async () => {
    await Promise.all(
      Array.from({ length: 1_002 }, async (_, index) =>
        writeFile(
          path.join(workspace, `file-${String(index).padStart(4, "0")}.txt`),
          String(index),
          "utf8",
        ),
      ),
    );
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    await symlink(
      outside,
      path.join(workspace, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const defaultArguments = await listFilesTool.parseAndNormalize(
      { path: "." },
      normalizeContext,
    );
    const defaultResult = await listFilesTool.execute(
      defaultArguments.arguments,
      executionContext,
    );
    const defaultEntries = entriesFrom(defaultResult.content);
    expect(defaultEntries).toHaveLength(200);
    expect(defaultResult.truncated).toBe(true);
    expect(defaultEntries.map((entry) => entry.path)).toEqual(
      [...defaultEntries.map((entry) => entry.path)].sort(),
    );
    expect(defaultEntries.every((entry) => !path.isAbsolute(entry.path))).toBe(true);
    expect(defaultEntries.some((entry) => entry.path.includes("secret.txt"))).toBe(
      false,
    );

    const cappedArguments = await listFilesTool.parseAndNormalize(
      { path: ".", maxEntries: 9_999 },
      normalizeContext,
    );
    const cappedResult = await listFilesTool.execute(
      cappedArguments.arguments,
      executionContext,
    );
    expect(entriesFrom(cappedResult.content)).toHaveLength(1_000);
    expect(cappedResult.truncated).toBe(true);
  }, 15_000);

  it("rejects glob patterns that can traverse outside the Workspace", async () => {
    for (const globPattern of [
      "../outside/*",
      "..\\outside\\*",
      "/outside/*",
      "C:\\outside\\*",
      "safe\0*",
    ]) {
      await expect(
        listFilesTool.parseAndNormalize(
          { path: ".", glob: globPattern },
          normalizeContext,
        ),
      ).rejects.toMatchObject({ code: "path_outside_workspace" });
    }

    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    const encodedParent = await listFilesTool.parseAndNormalize(
      { path: ".", glob: "[.][.]/outside/*" },
      normalizeContext,
    );

    const result = await listFilesTool.execute(
      encodedParent.arguments,
      executionContext,
    );

    expect(entriesFrom(result.content)).toEqual([]);
  });

  it("reads inclusive line ranges", async () => {
    await writeFile(
      path.join(workspace, "lines.txt"),
      "one\r\ntwo\nthree\nfour",
      "utf8",
    );
    const normalized = await readFileTool.parseAndNormalize(
      { path: "lines.txt", startLine: 2, endLine: 3 },
      normalizeContext,
    );

    const result = await readFileTool.execute(
      normalized.arguments,
      executionContext,
    );

    expect(result.content).toMatchObject({
      path: "lines.txt",
      text: "two\nthree",
      startLine: 2,
      endLine: 3,
    });
    expect(result.truncated).toBe(false);
  });

  it("defaults reads to 256 KiB and caps them at 1 MiB", async () => {
    await writeFile(
      path.join(workspace, "large.txt"),
      Buffer.alloc(MEBIBYTE + 16, "a"),
    );
    const defaultArguments = await readFileTool.parseAndNormalize(
      { path: "large.txt" },
      normalizeContext,
    );
    const defaultResult = await readFileTool.execute(
      defaultArguments.arguments,
      executionContext,
    );
    expect(defaultResult.capturedBytes).toBe(256 * KIBIBYTE);
    expect(defaultResult.truncated).toBe(true);

    const cappedArguments = await readFileTool.parseAndNormalize(
      { path: "large.txt", maxBytes: 2 * MEBIBYTE },
      normalizeContext,
    );
    const cappedResult = await readFileTool.execute(
      cappedArguments.arguments,
      executionContext,
    );
    expect(cappedResult.capturedBytes).toBe(MEBIBYTE);
    expect(cappedResult.truncated).toBe(true);
  });

  it("creates once with mode 0600 and leaves no sibling temporary file", async () => {
    const normalized = await writeFileTool.parseAndNormalize(
      { path: "created.txt", content: "created", expectedSha256: null },
      normalizeContext,
    );

    const result = await writeFileTool.execute(
      normalized.arguments,
      executionContext,
    );

    expect(await readFile(path.join(workspace, "created.txt"), "utf8")).toBe(
      "created",
    );
    expect(result.content).toMatchObject({
      path: "created.txt",
      bytes: 7,
      sha256: sha256("created"),
    });
    if (process.platform !== "win32") {
      expect((await stat(path.join(workspace, "created.txt"))).mode & 0o777).toBe(
        0o600,
      );
    }
    expect(await temporaryEntries(workspace)).toEqual([]);
    await expect(
      writeFileTool.execute(normalized.arguments, executionContext),
    ).rejects.toMatchObject({ code: "file_changed" });
    expect(await temporaryEntries(workspace)).toEqual([]);
  });

  it("never replaces a file during create-only installation", async () => {
    const temporaryPath = path.join(workspace, ".create-only.tmp");
    const targetPath = path.join(workspace, "create-only.txt");
    await writeFile(temporaryPath, "proposed", "utf8");
    await writeFile(targetPath, "external", "utf8");

    await expect(
      installCreateOnly(temporaryPath, targetPath),
    ).rejects.toMatchObject({ code: "file_changed" });
    expect(await readFile(targetPath, "utf8")).toBe("external");
    expect(await readFile(temporaryPath, "utf8")).toBe("proposed");
  });

  it("replaces only the expected hash and preserves the target mode", async () => {
    const target = path.join(workspace, "replace.txt");
    await writeFile(target, "old", "utf8");
    if (process.platform !== "win32") {
      await chmod(target, 0o3640);
    }
    const normalized = await writeFileTool.parseAndNormalize(
      {
        path: "replace.txt",
        content: "new content",
        expectedSha256: sha256("old"),
      },
      normalizeContext,
    );

    await writeFileTool.execute(normalized.arguments, executionContext);

    expect(await readFile(target, "utf8")).toBe("new content");
    if (process.platform !== "win32") {
      expect((await stat(target)).mode & 0o777).toBe(0o640);
      expect((await stat(target)).mode & 0o7777).toBe(0o3640);
    }
    expect(await temporaryEntries(workspace)).toEqual([]);
    await expect(
      writeFileTool.execute(normalized.arguments, executionContext),
    ).rejects.toMatchObject({ code: "file_changed" });
    expect(await temporaryEntries(workspace)).toEqual([]);
  });

  it("retains POSIX special mode bits for replacement", () => {
    expect(preservedFileMode(0o103640)).toBe(0o3640);
  });

  it("accepts only one concurrent replacement for the same expected hash", async () => {
    const target = path.join(workspace, "concurrent.txt");
    await writeFile(target, "old", "utf8");
    const expectedSha256 = sha256("old");
    const first = await writeFileTool.parseAndNormalize(
      { path: "concurrent.txt", content: "first", expectedSha256 },
      normalizeContext,
    );
    const second = await writeFileTool.parseAndNormalize(
      { path: "concurrent.txt", content: "second", expectedSha256 },
      normalizeContext,
    );

    const outcomes = await Promise.allSettled([
      writeFileTool.execute(first.arguments, executionContext),
      writeFileTool.execute(second.arguments, executionContext),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(
      1,
    );
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "file_changed" },
    });
    expect(["first", "second"]).toContain(
      await readFile(target, "utf8"),
    );
    expect(await temporaryEntries(workspace)).toEqual([]);
  });

  it("serializes same-target write critical sections", async () => {
    const coordinator = new TargetWriteCoordinator();
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const events: string[] = [];
    const first = coordinator.run("same-target", async () => {
      events.push("first entered");
      firstEntered.resolve();
      await releaseFirst.promise;
      events.push("first exited");
    });
    await firstEntered.promise;

    const second = coordinator.run("same-target", async () => {
      events.push("second entered");
    });
    await Promise.resolve();

    expect(events).toEqual(["first entered"]);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "first entered",
      "first exited",
      "second entered",
    ]);
  });

  it("uses strict write arguments and enforces the UTF-8 content cap", async () => {
    await expect(
      writeFileTool.parseAndNormalize(
        {
          path: "large.txt",
          content: "a".repeat(MEBIBYTE + 1),
          expectedSha256: null,
        },
        normalizeContext,
      ),
    ).rejects.toBeDefined();
    await expect(
      writeFileTool.parseAndNormalize(
        {
          path: "unknown.txt",
          content: "content",
          expectedSha256: null,
          unexpected: true,
        },
        normalizeContext,
      ),
    ).rejects.toBeDefined();
  });
});

interface ListedEntry {
  path: string;
  type: string;
  size: number;
}

function entriesFrom(content: unknown): ListedEntry[] {
  return (content as { entries: ListedEntry[] }).entries;
}

async function temporaryEntries(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((entry) => entry.includes(".tmp-"));
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function revisionFor(workspace: string): AgentRevisionSnapshot {
  const agentId = parseAgentId("primary");
  return {
    revisionId: "rev_file_tools",
    agentId,
    displayName: "Primary",
    prompt: "Primary Agent",
    model: {
      provider: "openai-compatible",
      model: "test-model",
      baseUrl: "https://example.invalid/v1",
      apiKey: { fromEnvironment: "TEST_API_KEY" },
      maxInputTokens: 8_192,
    },
    workspace,
    skills: [],
    policy: [],
    delegates: [],
    limits: DEFAULT_RUN_LIMITS,
    contentSha256: "0".repeat(64),
  };
}
