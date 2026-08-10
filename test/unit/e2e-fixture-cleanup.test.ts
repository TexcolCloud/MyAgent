import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, it } from "vitest";

import {
  prepareE2eFixture,
  removeE2eFixtureRoot,
  waitForE2eFixtureRootRelease,
  waitForFaultChildCompletion,
} from "../helpers/fault-controller.js";

it.skipIf(process.platform !== "win32")(
  "waits for a transient Windows fixture owner without partially deleting it",
  async () => {
    const fixture = await prepareE2eFixture("http://127.0.0.1:1/v1");
    const sentinel = path.join(fixture.root, "fixture-owner-sentinel.txt");
    await writeFile(sentinel, "owned", "utf8");
    const database = new DatabaseSync(fixture.databasePath);
    let cleanup: Promise<void> | undefined;
    let closed = false;
    try {
      cleanup = fixture.cleanup();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(existsSync(sentinel)).toBe(true);

      database.close();
      closed = true;
      await cleanup;
      expect(existsSync(fixture.root)).toBe(false);
    } finally {
      if (!closed) database.close();
      await cleanup?.catch(() => undefined);
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
  5_000,
);

it.skipIf(process.platform !== "win32")(
  "bounds a persistent Windows fixture cleanup failure",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "myagent-e2e-cleanup-"));
    const database = new DatabaseSync(path.join(root, "kernel.db"));
    const startedAt = Date.now();
    try {
      await expect(removeE2eFixtureRoot(root, { releaseTimeoutMs: 100 }))
        .rejects.toThrow("e2e_fixture_root_release_timeout");
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(existsSync(root)).toBe(true);
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  10_000,
);

it.skipIf(process.platform !== "win32")(
  "deletes only the claimed fixture when the original path is replaced",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "myagent-e2e-claim-"));
    const original = path.join(root, "original.txt");
    const replacement = path.join(root, "replacement.txt");
    let claimedRoot: string | undefined;
    await writeFile(original, "original", "utf8");
    try {
      await removeE2eFixtureRoot(root, {
        async onClaimed(claimed): Promise<void> {
          claimedRoot = claimed;
          expect(existsSync(root)).toBe(false);
          expect(existsSync(path.join(claimed, "original.txt"))).toBe(true);
          await mkdir(root);
          await writeFile(replacement, "replacement", "utf8");
        },
      });

      expect(claimedRoot).toBeDefined();
      expect(existsSync(replacement)).toBe(true);
      expect(existsSync(original)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
      if (claimedRoot !== undefined) {
        await rm(claimedRoot, { recursive: true, force: true });
      }
    }
  },
  5_000,
);

it.skipIf(process.platform !== "win32")(
  "does not report a spawn error before fixture ownership is released",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "myagent-e2e-child-error-"));
    const database = new DatabaseSync(path.join(root, "kernel.db"));
    const child = spawn(path.join(root, "missing-child.exe"), [], {
      stdio: "ignore",
      windowsHide: true,
    });
    const completion = waitForFaultChildCompletion(child, root, []);
    let settled = false;
    void completion.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    let closed = false;
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      database.close();
      closed = true;
      await expect(completion).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (!closed) database.close();
      await completion.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
  5_000,
);

it.skipIf(process.platform !== "win32")(
  "restores a release probe after transient reverse-rename contention",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "myagent-e2e-restore-"));
    const sentinel = path.join(root, "restore-sentinel.txt");
    let releaseReplacement: Promise<void> | undefined;
    await writeFile(sentinel, "restore", "utf8");
    try {
      await waitForE2eFixtureRootRelease(root, {
        releaseTimeoutMs: 1_000,
        async onProbed(): Promise<void> {
          await mkdir(root);
          await writeFile(path.join(root, "replacement.txt"), "temporary", "utf8");
          releaseReplacement = new Promise((resolve, reject) => {
            setTimeout(() => {
              void rm(root, { recursive: true, force: true }).then(resolve, reject);
            }, 100);
          });
        },
      });

      await releaseReplacement;
      expect(existsSync(sentinel)).toBe(true);
      expect(existsSync(path.join(root, "replacement.txt"))).toBe(false);
    } finally {
      await releaseReplacement?.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
  5_000,
);

it.skipIf(process.platform !== "win32")(
  "bounds a child error that is not followed by close",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "myagent-e2e-missing-close-"));
    const child = new EventEmitter() as ChildProcess;
    try {
      const completion = waitForFaultChildCompletion(child, root, [], {
        closeTimeoutMs: 50,
      });
      child.emit("error", new Error("spawn_failed_without_close"));
      expect(await completionOutcome(completion, 250))
        .toBe("fault_child_close_timeout");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  1_000,
);

it.skipIf(process.platform !== "win32")(
  "bounds a termination request that is not followed by close",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "myagent-e2e-kill-no-close-"));
    const child = new EventEmitter() as ChildProcess;
    const termination = new AbortController();
    try {
      const completion = waitForFaultChildCompletion(child, root, [], {
        closeTimeoutMs: 50,
        terminationSignal: termination.signal,
      });
      termination.abort();
      expect(await completionOutcome(completion, 250))
        .toBe("fault_child_close_timeout");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  1_000,
);

async function completionOutcome(
  completion: Promise<void>,
  timeoutMs: number,
): Promise<string> {
  return await Promise.race([
    completion.then(
      () => "resolved",
      (error: unknown) => error instanceof Error ? error.message : String(error),
    ),
    new Promise<string>((resolve) => {
      setTimeout(() => resolve("unbounded"), timeoutMs);
    }),
  ]);
}
