import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PathGuard } from "../../src/adapters/tools/path-guard.js";

describe("PathGuard", () => {
  let root: string;
  let workspace: string;
  let outsideDirectory: string;
  let outsideFile: string;
  let guard: PathGuard;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "myagent-path-guard-"));
    workspace = path.join(root, "workspace");
    outsideDirectory = path.join(root, "outside");
    outsideFile = path.join(outsideDirectory, "outside.txt");
    await mkdir(workspace);
    await mkdir(outsideDirectory);
    await writeFile(outsideFile, "outside", "utf8");
    await writeFile(path.join(workspace, "inside.txt"), "inside", "utf8");
    guard = new PathGuard(workspace);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves an existing path inside the Workspace", async () => {
    await expect(guard.resolveExisting("inside.txt")).resolves.toBe(
      await realpath(path.join(workspace, "inside.txt")),
    );
  });

  it("rejects lexical escapes from the Workspace", async () => {
    await expect(guard.resolveExisting("../outside/outside.txt")).rejects.toMatchObject({
      code: "path_outside_workspace",
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects file-symlink escapes from the Workspace",
    async () => {
      await symlink(outsideFile, path.join(workspace, "linked.txt"), "file");
      await expect(guard.resolveExisting("linked.txt")).rejects.toMatchObject({
        code: "path_outside_workspace",
      });
    },
  );

  it("rejects absolute paths and NUL bytes", async () => {
    await expect(guard.resolveExisting(outsideFile)).rejects.toMatchObject({
      code: "path_outside_workspace",
    });
    await expect(guard.resolveExisting("inside\0.txt")).rejects.toMatchObject({
      code: "path_outside_workspace",
    });
  });

  it("checks the real parent when the target does not exist", async () => {
    await symlink(
      outsideDirectory,
      path.join(workspace, "linked-dir"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      guard.resolveForCreate("linked-dir/new.txt"),
    ).rejects.toMatchObject({ code: "path_outside_workspace" });
  });

  it("appends validated missing segments beneath the nearest real parent", async () => {
    await expect(guard.resolveForCreate("new/nested/file.txt")).resolves.toBe(
      path.join(await realpath(workspace), "new", "nested", "file.txt"),
    );
  });
});
