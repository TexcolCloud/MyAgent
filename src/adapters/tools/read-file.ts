import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { ToolDefinition } from "../../ports/tool.js";
import { PathGuard } from "./path-guard.js";

const KIBIBYTE = 1_024;
const DEFAULT_MAX_BYTES = 256 * KIBIBYTE;
const MAX_BYTES = 1_024 * KIBIBYTE;

const readFileSchema = z
  .strictObject({
    path: z.string().min(1),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    maxBytes: z.number().int().positive().optional(),
  })
  .refine(
    (value) =>
      value.endLine === undefined ||
      value.startLine === undefined ||
      value.endLine >= value.startLine,
    { message: "endLine must be greater than or equal to startLine" },
  );

type ReadFileArguments = {
  path: string;
  startLine: number;
  endLine: number | null;
  maxBytes: number;
};

export const readFileTool: ToolDefinition<ReadFileArguments> = {
  name: "read_file",
  effect: "read_only",

  async parseAndNormalize(raw, context) {
    const parsed = readFileSchema.parse(raw);
    await new PathGuard(context.revision.workspace).resolveExisting(parsed.path);
    return {
      arguments: {
        path: portablePath(path.normalize(parsed.path)),
        startLine: parsed.startLine ?? 1,
        endLine: parsed.endLine ?? null,
        maxBytes: Math.min(parsed.maxBytes ?? DEFAULT_MAX_BYTES, MAX_BYTES),
      },
      policyFacts: { pathWithinWorkspace: true },
    };
  },

  async execute(args, context) {
    context.signal.throwIfAborted();
    const absolutePath = await new PathGuard(
      context.revision.workspace,
    ).resolveExisting(args.path);
    const handle = await open(absolutePath, "r");
    try {
      const limit = Math.min(
        args.maxBytes,
        Math.max(0, context.remainingRunOutputBytes),
      );
      const prefix = await readPrefix(handle, limit + 1, context.signal);
      const captured = prefix.subarray(0, limit);
      const sourceTruncated = prefix.length > limit;
      const decoded = captured.toString("utf8").replaceAll("\r\n", "\n");
      const lines = decoded.split("\n");
      const selected = lines.slice(
        args.startLine - 1,
        args.endLine === null ? undefined : args.endLine,
      );
      const text = selected.join("\n");
      const rangeComplete =
        args.endLine !== null &&
        (args.endLine < lines.length ||
          (!sourceTruncated && args.endLine <= lines.length));
      const truncated =
        args.endLine === null ? sourceTruncated : !rangeComplete;
      const content = {
        path: args.path,
        text,
        startLine: args.startLine,
        endLine:
          selected.length === 0
            ? args.startLine - 1
            : args.startLine + selected.length - 1,
      };
      return {
        ok: true,
        summary: `Read ${captured.length} bytes from a Workspace file.`,
        content,
        capturedBytes: captured.length,
        truncated,
      };
    } finally {
      await handle.close();
    }
  },
};

async function readPrefix(
  handle: FileHandle,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const buffer = Buffer.alloc(maxBytes);
  let offset = 0;
  while (offset < buffer.length) {
    signal.throwIfAborted();
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

function portablePath(candidate: string): string {
  return candidate.split(path.sep).join("/");
}
