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

export const listFilesTool: ToolDefinition<ListFilesArguments> = {
  name: "list_files",
  effect: "read_only",

  async parseAndNormalize(raw, context) {
    const parsed = listFilesSchema.parse(raw);
    await new PathGuard(context.revision.workspace).resolveExisting(parsed.path);
    return {
      arguments: {
        path: portablePath(path.normalize(parsed.path)),
        glob: parsed.glob ?? "**/*",
        maxEntries: Math.min(parsed.maxEntries ?? DEFAULT_MAX_ENTRIES, MAX_ENTRIES),
      },
      policyFacts: { pathWithinWorkspace: true },
    };
  },

  async execute(args, context) {
    context.signal.throwIfAborted();
    const guard = new PathGuard(context.revision.workspace);
    const basePath = await guard.resolveExisting(args.path);
    const entries: ListedEntry[] = [];

    for await (const entry of glob(args.glob, {
      cwd: basePath,
      withFileTypes: true,
      // Node follows Windows junctions during glob traversal unless they are
      // excluded while walking, not merely filtered after a match is emitted.
      exclude: (candidate) => candidate.isSymbolicLink(),
    })) {
      context.signal.throwIfAborted();
      const lexicalPath = path.join(entry.parentPath, entry.name);
      assertLexicallyWithin(basePath, lexicalPath);
      const relativeToBase = path.relative(basePath, lexicalPath);
      const workspacePath = path.join(args.path, relativeToBase);

      const canonicalPath = await guard.resolveExisting(workspacePath);
      const metadata = await lstat(canonicalPath);
      entries.push({
        path: portablePath(path.normalize(workspacePath)),
        type: metadata.isDirectory()
          ? "directory"
          : metadata.isFile()
            ? "file"
            : "other",
        size: metadata.size,
      });
    }

    entries.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    const truncated = entries.length > args.maxEntries;
    const content = { entries: entries.slice(0, args.maxEntries) };
    return {
      ok: true,
      summary: `Listed ${content.entries.length} Workspace entries.`,
      content,
      capturedBytes: Buffer.byteLength(JSON.stringify(content), "utf8"),
      truncated,
    };
  },
};

function portablePath(candidate: string): string {
  return candidate.split(path.sep).join("/");
}

function assertLexicallyWithin(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new DomainError("path_outside_workspace");
  }
}
