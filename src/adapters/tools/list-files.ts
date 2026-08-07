import { glob, lstat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { DomainError } from "../../domain/errors.js";
import type { ToolDefinition } from "../../ports/tool.js";
import { PathGuard } from "./path-guard.js";

const DEFAULT_MAX_ENTRIES = 200;
const MAX_ENTRIES = 1_000;

const listFilesSchema = z.strictObject({
  path: z.string().min(1),
  glob: z.string().min(1).optional(),
  maxEntries: z.number().int().positive().optional(),
});

type ListFilesArguments = {
  path: string;
  glob: string;
  maxEntries: number;
};

type ListedEntry = {
  path: string;
  type: "directory" | "file" | "other";
  size: number;
};

export class BoundedLexicalEntries<T extends { path: string }> {
  readonly #entries: T[] = [];
  #seen = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("capacity must be a positive integer");
    }
  }

  add(entry: T): void {
    this.#seen += 1;
    let lower = 0;
    let upper = this.#entries.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (this.#entries[middle]!.path < entry.path) {
        lower = middle + 1;
      } else {
        upper = middle;
      }
    }
    if (lower >= this.capacity) {
      return;
    }
    this.#entries.splice(lower, 0, entry);
    if (this.#entries.length > this.capacity) {
      this.#entries.pop();
    }
  }

  get truncated(): boolean {
    return this.#seen > this.capacity;
  }

  values(): T[] {
    return [...this.#entries];
  }
}

export const listFilesTool: ToolDefinition<ListFilesArguments> = {
  name: "list_files",
  effect: "read_only",

  async parseAndNormalize(raw, context) {
    const parsed = listFilesSchema.parse(raw);
    await new PathGuard(context.revision.workspace).resolveExisting(parsed.path);
    const globPattern = parsed.glob ?? "**/*";
    assertGlobPatternWithinWorkspace(globPattern);
    return {
      arguments: {
        path: portablePath(path.normalize(parsed.path)),
        glob: globPattern,
        maxEntries: Math.min(parsed.maxEntries ?? DEFAULT_MAX_ENTRIES, MAX_ENTRIES),
      },
      policyFacts: { pathWithinWorkspace: true },
    };
  },

  async execute(args, context) {
    context.signal.throwIfAborted();
    const guard = new PathGuard(context.revision.workspace);
    const basePath = await guard.resolveExisting(args.path);
    const entries = new BoundedLexicalEntries<ListedEntry>(args.maxEntries);

    for await (const entry of glob(args.glob, {
      cwd: basePath,
      withFileTypes: true,
      // Node follows Windows junctions during glob traversal unless they are
      // excluded while walking, not merely filtered after a match is emitted.
      exclude: (candidate) => {
        const candidatePath = path.resolve(
          basePath,
          candidate.parentPath,
          candidate.name,
        );
        return (
          candidate.isSymbolicLink() ||
          !isLexicallyWithin(basePath, candidatePath)
        );
      },
    })) {
      context.signal.throwIfAborted();
      const lexicalPath = path.join(entry.parentPath, entry.name);
      assertLexicallyWithin(basePath, lexicalPath);
      const relativeToBase = path.relative(basePath, lexicalPath);
      const workspacePath = path.join(args.path, relativeToBase);

      const canonicalPath = await guard.resolveExisting(workspacePath);
      const metadata = await lstat(canonicalPath);
      entries.add({
        path: portablePath(path.normalize(workspacePath)),
        type: metadata.isDirectory()
          ? "directory"
          : metadata.isFile()
            ? "file"
            : "other",
        size: metadata.size,
      });
    }

    const content = { entries: entries.values() };
    return {
      ok: true,
      summary: `Listed ${content.entries.length} Workspace entries.`,
      content,
      capturedBytes: Buffer.byteLength(JSON.stringify(content), "utf8"),
      truncated: entries.truncated,
    };
  },
};

function portablePath(candidate: string): string {
  return candidate.split(path.sep).join("/");
}

function assertLexicallyWithin(root: string, candidate: string): void {
  if (!isLexicallyWithin(root, candidate)) {
    throw new DomainError("path_outside_workspace");
  }
}

function isLexicallyWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !(
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  );
}

function assertGlobPatternWithinWorkspace(pattern: string): void {
  const hasParentSegment = pattern
    .split(/[\\/]+/u)
    .some((segment) => segment === "..");
  if (
    pattern.includes("\0") ||
    path.posix.isAbsolute(pattern) ||
    path.win32.parse(pattern).root !== "" ||
    hasParentSegment
  ) {
    throw new DomainError("path_outside_workspace");
  }
}
