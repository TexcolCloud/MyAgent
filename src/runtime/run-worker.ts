import type { AdvanceRunService } from "../application/advance-run.js";
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
  private readonly active = new Set<AbortController>();
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
    for (const controller of this.active) controller.abort(new Error("worker_stopped"));
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
        busyDelayMs = 50;
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
        await this.options.clock.sleep(busyDelayMs);
        busyDelayMs = Math.min(1_000, busyDelayMs * 2);
        continue;
      }
      if (run === null) {
        await this.options.clock.sleep(this.idleDelayMs);
        continue;
      }
      const controller = new AbortController();
      const heartbeat = new LeaseHeartbeat(
        this.options.runs, this.options.clock, run.runId, leaseOwner, this.leaseDurationMs,
      );
      this.active.add(controller);
      heartbeat.start();
      try {
        while (this.running && !controller.signal.aborted) {
          const outcome = await this.options.advance.advance(run.runId, leaseOwner, controller.signal);
          if (outcome.type !== "advanced") break;
        }
      } catch (error) {
        if (!controller.signal.aborted && !isSqliteBusy(error)) throw error;
      } finally {
        heartbeat.stop();
        this.active.delete(controller);
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
