import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SystemClock } from "../../src/adapters/system-clock.js";
import { bootstrap } from "../../src/bootstrap.js";
import type { Clock } from "../../src/ports/clock.js";
import type { FaultInjector } from "../../src/runtime/fault-injector.js";

const VALID_FIXTURE = fileURLToPath(new URL("../fixtures/config/valid", import.meta.url));

describe("worker readiness", () => {
  it.each([
    { name: "during startup", releaseAfterListen: false },
    { name: "after listening", releaseAfterListen: true },
  ])(
    "latches a fatal Run worker failure $name",
    async ({ releaseAfterListen }) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "myagent-worker-ready-"));
      const configRoot = path.join(root, "config");
      await cp(VALID_FIXTURE, configRoot, { recursive: true });
      const previousBearer = process.env.MYAGENT_BEARER_TOKEN;
      const previousAdmin = process.env.MYAGENT_ADMIN_TOKEN;
      process.env.MYAGENT_BEARER_TOKEN = "worker-readiness-run-token";
      process.env.MYAGENT_ADMIN_TOKEN = "worker-readiness-admin-token";
      const reached = deferred();
      const release = deferred();
      let injected = false;
      const faults: FaultInjector = {
        async hit(point): Promise<void> {
          if (point !== "before_run_claim" || injected) return;
          injected = true;
          reached.resolve();
          await release.promise;
          throw new Error("fatal_run_worker_for_readiness");
        },
      };
      let service: Awaited<ReturnType<typeof bootstrap>> | undefined;
      try {
        const booting = bootstrap(path.join(configRoot, "myagent.yaml"), {
          listen: { host: "127.0.0.1", port: 0 },
          signals: false,
          log: { write: () => {} },
          faults,
          worker: { concurrency: 1 },
        });
        await reached.promise;
        if (!releaseAfterListen) release.resolve();
        service = await booting;
        if (releaseAfterListen) {
          expect(await readReady(service.url)).toBe(true);
          release.resolve();
        }

        expect(await waitForReady(service.url, false)).toBe(false);
      } finally {
        release.resolve();
        await service?.shutdown().catch(() => undefined);
        restoreEnvironment("MYAGENT_BEARER_TOKEN", previousBearer);
        restoreEnvironment("MYAGENT_ADMIN_TOKEN", previousAdmin);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { name: "during startup", releaseAfterListen: false },
    { name: "after listening", releaseAfterListen: true },
  ])(
    "latches a fatal Approval expiration worker failure $name",
    async ({ releaseAfterListen }) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "myagent-expirer-ready-"));
      const configRoot = path.join(root, "config");
      await cp(VALID_FIXTURE, configRoot, { recursive: true });
      const previousBearer = process.env.MYAGENT_BEARER_TOKEN;
      const previousAdmin = process.env.MYAGENT_ADMIN_TOKEN;
      process.env.MYAGENT_BEARER_TOKEN = "expirer-readiness-run-token";
      process.env.MYAGENT_ADMIN_TOKEN = "expirer-readiness-admin-token";
      const clock = new FailingApprovalClock();
      let service: Awaited<ReturnType<typeof bootstrap>> | undefined;
      try {
        const booting = bootstrap(path.join(configRoot, "myagent.yaml"), {
          listen: { host: "127.0.0.1", port: 0 },
          signals: false,
          log: { write: () => {} },
          worker: { concurrency: 1 },
          clock,
        });
        if (!releaseAfterListen) {
          await clock.waitUntilBlocked();
          clock.release();
        }
        service = await booting;
        if (releaseAfterListen) {
          await clock.waitUntilBlocked();
          expect(await readReady(service.url)).toBe(true);
          clock.release();
        }

        expect(await waitForReady(service.url, false)).toBe(false);
      } finally {
        clock.release();
        await service?.shutdown().catch(() => undefined);
        restoreEnvironment("MYAGENT_BEARER_TOKEN", previousBearer);
        restoreEnvironment("MYAGENT_ADMIN_TOKEN", previousAdmin);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

async function waitForReady(url: string, expected: boolean): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  let ready = await readReady(url);
  while (ready !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    ready = await readReady(url);
  }
  return ready;
}

async function readReady(url: string): Promise<boolean> {
  const response = await fetch(`${url}/readyz`);
  return response.status === 200 && (await response.json() as { ready: boolean }).ready;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FailingApprovalClock implements Clock {
  private readonly delegate = new SystemClock();
  private readonly entered = deferred();
  private readonly failure = deferred();
  private injected = false;

  now(): Date {
    return this.delegate.now();
  }

  async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (milliseconds === 60_000 && !this.injected) {
      this.injected = true;
      this.entered.resolve();
      await this.failure.promise;
      throw new Error("fatal_approval_expirer_for_readiness");
    }
    await this.delegate.sleep(milliseconds, signal);
  }

  release(): void {
    this.failure.resolve();
  }

  async waitUntilBlocked(): Promise<void> {
    await this.entered.promise;
  }
}
