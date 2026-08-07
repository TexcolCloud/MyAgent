import { createHash, randomUUID } from "node:crypto";
import {
  link,
  open,
  readFile,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { DomainError } from "../../domain/errors.js";
import type { ToolDefinition } from "../../ports/tool.js";
import { PathGuard } from "./path-guard.js";

const MAX_CONTENT_BYTES = 1_024 * 1_024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const writeFileSchema = z
  .strictObject({
    path: z.string().min(1),
    content: z.string(),
    expectedSha256: z.string().regex(SHA256_PATTERN).nullable(),
  })
  .refine(
    (value) => Buffer.byteLength(value.content, "utf8") <= MAX_CONTENT_BYTES,
    { message: "content exceeds 1 MiB" },
  );

type WriteFileArguments = {
  path: string;
  content: string;
  expectedSha256: string | null;
};

export class TargetWriteCoordinator {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(targetPath: string, operation: () => Promise<T>): Promise<T> {
    const key = normalizedLockKey(targetPath);
    const predecessor = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.then(() => current);
    this.#tails.set(key, tail);

    await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(key) === tail) {
        this.#tails.delete(key);
      }
    }
  }
}

const targetWriteCoordinator = new TargetWriteCoordinator();

export const writeFileTool: ToolDefinition<WriteFileArguments> = {
  name: "write_file",
  effect: "side_effect",

  async parseAndNormalize(raw, context) {
    const parsed = writeFileSchema.parse(raw);
    await new PathGuard(context.revision.workspace).resolveForCreate(parsed.path);
    return {
      arguments: {
        path: portablePath(path.normalize(parsed.path)),
        content: parsed.content,
        expectedSha256: parsed.expectedSha256,
      },
      policyFacts: { pathWithinWorkspace: true },
    };
  },

  async execute(args, context) {
    context.signal.throwIfAborted();
    const targetPath = await new PathGuard(
      context.revision.workspace,
    ).resolveForCreate(args.path);
    return targetWriteCoordinator.run(targetPath, async () => {
      context.signal.throwIfAborted();
      const initialState = await inspectTarget(targetPath);
      assertExpected(initialState, args.expectedSha256);
      const mode = args.expectedSha256 === null ? 0o600 : initialState.mode;
      const temporaryPath = path.join(
        path.dirname(targetPath),
        `.${path.basename(targetPath)}.tmp-${randomUUID()}`,
      );
      let temporaryHandle: FileHandle | undefined;

      try {
        temporaryHandle = await open(temporaryPath, "wx", mode);
        assertExpected(await inspectTarget(targetPath), args.expectedSha256);
        await temporaryHandle.writeFile(args.content, "utf8");
        await temporaryHandle.chmod(mode);
        await temporaryHandle.sync();
        await temporaryHandle.close();
        temporaryHandle = undefined;

        context.signal.throwIfAborted();
        assertExpected(await inspectTarget(targetPath), args.expectedSha256);
        if (args.expectedSha256 === null) {
          await installCreateOnly(temporaryPath, targetPath);
        } else {
          await rename(temporaryPath, targetPath);
        }
      } finally {
        try {
          await temporaryHandle?.close();
        } finally {
          await rm(temporaryPath, { force: true });
        }
      }

      const content = {
        path: args.path,
        bytes: Buffer.byteLength(args.content, "utf8"),
        sha256: sha256Buffer(Buffer.from(args.content, "utf8")),
      };
      return {
        ok: true,
        summary: `Wrote ${content.bytes} bytes to a Workspace file.`,
        content,
        capturedBytes: Buffer.byteLength(JSON.stringify(content), "utf8"),
        truncated: false,
      };
    });
  },
};

interface TargetState {
  exists: boolean;
  sha256: string | null;
  mode: number;
}

export async function installCreateOnly(
  temporaryPath: string,
  targetPath: string,
): Promise<void> {
  try {
    await link(temporaryPath, targetPath);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      throw changedFile();
    }
    throw error;
  }
}

async function inspectTarget(targetPath: string): Promise<TargetState> {
  try {
    const metadata = await stat(targetPath);
    if (!metadata.isFile()) {
      throw changedFile();
    }
    return {
      exists: true,
      sha256: sha256Buffer(await readFile(targetPath)),
      mode: preservedFileMode(metadata.mode),
    };
  } catch (error) {
    if (isMissing(error)) {
      return { exists: false, sha256: null, mode: 0o600 };
    }
    throw error;
  }
}

export function preservedFileMode(mode: number): number {
  return mode & 0o7777;
}

function assertExpected(state: TargetState, expectedSha256: string | null): void {
  if (expectedSha256 === null) {
    if (state.exists) {
      throw changedFile();
    }
    return;
  }
  if (!state.exists || state.sha256 !== expectedSha256) {
    throw changedFile();
  }
}

function sha256Buffer(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isMissing(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function changedFile(): DomainError {
  return new DomainError("file_changed");
}

function portablePath(candidate: string): string {
  return candidate.split(path.sep).join("/");
}

function normalizedLockKey(targetPath: string): string {
  const absolutePath = path.resolve(targetPath);
  return process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath;
}
