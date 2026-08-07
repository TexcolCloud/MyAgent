import type { AdvanceRunService } from "../application/advance-run.js";
import type { RunId } from "../domain/ids.js";
import type { Clock } from "../ports/clock.js";
import type { RunStore } from "../ports/run-store.js";
import { LeaseHeartbeat } from "./lease-heartbeat.js";

export interface RunWorkerOptions {
  runs: RunStore;
  advance: AdvanceRunService;
  clock: Clock;
  workerId: string;
  concurrency?: number;
  leaseDurationMs?: number;
  idleDelayMs?: number;
}

export class RunWorker {
  private readonly concurrency: number;
  private readonly leaseDurationMs: number;
  private readonly idleDelayMs: number;
  private readonly active = new Map<RunId, AbortController>();
  private loops: Promise<void>[] = [];
  private running = false;

  constructor(private readonly options: RunWorkerOptions) {
    this.concurrency = options.concurrency ?? 4;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.idleDelayMs = options.idleDelayMs ?? 50;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loops = Array.from({ length: this.concurrency }, (_, index) => this.claimLoop(index));
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const [runId, controller] of this.active) {
      if (this.options.advance.isAbortSafe(runId)) {
        controller.abort(new Error("worker_stopped"));
      }
    }
    await Promise.all(this.loops);
    this.loops = [];
  }

  private async claimLoop(index: number): Promise<void> {
    let busyDelayMs = 50;
    const leaseOwner = `${this.options.workerId}:${index}`;
    while (this.running) {
      let run;
      try {
        const now = this.options.clock.now();
        run = this.options.runs.claimNextEligible(
          leaseOwner,
          now,
          new Date(now.getTime() + this.leaseDurationMs),
        );
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
        await this.options.clock.sleep(busyDelayMs);
        busyDelayMs = Math.min(1_000, busyDelayMs * 2);
        continue;
      }
      if (run === null) {
        busyDelayMs = 50;
        await this.options.clock.sleep(this.idleDelayMs);
        continue;
      }
      const controller = new AbortController();
      let heartbeatFailure: unknown;
      const heartbeat = new LeaseHeartbeat(
        this.options.runs,
        this.options.clock,
        run.runId,
        leaseOwner,
        this.leaseDurationMs,
        (error) => {
          heartbeatFailure = error;
          if (this.options.advance.isAbortSafe(run.runId)) {
            controller.abort(error);
          }
        },
      );
      this.active.set(run.runId, controller);
      heartbeat.start();
      let shouldBackOff = false;
      try {
        while (this.running && !controller.signal.aborted) {
          const outcome = await this.options.advance.advance(run.runId, leaseOwner, controller.signal);
          if (heartbeatFailure !== undefined) throw heartbeatFailure;
          busyDelayMs = 50;
          if (outcome.type !== "advanced") break;
        }
      } catch (error) {
        const cause = heartbeatFailure ?? error;
        if (isSqliteBusy(cause)) {
          shouldBackOff = true;
        } else if (heartbeatFailure !== undefined && !isLeaseLost(cause)) {
          throw cause;
        } else if (!controller.signal.aborted && !isLeaseLost(cause)) {
          throw cause;
        }
      } finally {
        heartbeat.stop();
        this.active.delete(run.runId);
      }
      if (shouldBackOff && this.running) {
        await this.options.clock.sleep(busyDelayMs);
        busyDelayMs = Math.min(1_000, busyDelayMs * 2);
      }
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && (
    (error as Error & { errcode?: unknown }).errcode === 5 ||
    /database is locked|database is busy/i.test(error.message)
  );
}

function isLeaseLost(error: unknown): boolean {
  return error instanceof Error &&
    (error as Error & { code?: unknown }).code === "run_lease_lost";
}
