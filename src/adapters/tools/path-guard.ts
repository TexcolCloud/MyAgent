import { realpath } from "node:fs/promises";
import path from "node:path";

import { DomainError } from "../../domain/errors.js";

export class PathGuard {
  readonly #workspace: Promise<string>;

  constructor(workspace: string) {
    this.#workspace = realpath(workspace);
  }

  async resolveExisting(candidate: string): Promise<string> {
    const workspace = await this.#workspace;
    const lexicalPath = resolveLexical(workspace, candidate);
    const canonicalPath = await realpath(lexicalPath);
    assertWithin(workspace, canonicalPath);
    return canonicalPath;
  }

  async resolveForCreate(candidate: string): Promise<string> {
    const workspace = await this.#workspace;
    const lexicalPath = resolveLexical(workspace, candidate);

    try {
      const canonicalPath = await realpath(lexicalPath);
      assertWithin(workspace, canonicalPath);
      return canonicalPath;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }

    const missingSegments: string[] = [path.basename(lexicalPath)];
    let ancestor = path.dirname(lexicalPath);
    while (true) {
      try {
        const canonicalParent = await realpath(ancestor);
        assertWithin(workspace, canonicalParent);
        return path.join(canonicalParent, ...missingSegments);
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
      }

      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        throw outsideWorkspace();
      }
      missingSegments.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function resolveLexical(workspace: string, candidate: string): string {
  if (candidate.includes("\0") || path.isAbsolute(candidate)) {
    throw outsideWorkspace();
  }
  const resolved = path.resolve(workspace, candidate);
  assertWithin(workspace, resolved);
  return resolved;
}

function assertWithin(workspace: string, candidate: string): void {
  const relative = path.relative(workspace, candidate);
  if (
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw outsideWorkspace();
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function outsideWorkspace(): DomainError {
  return new DomainError("path_outside_workspace");
}
