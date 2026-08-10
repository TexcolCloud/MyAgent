import type { AdvanceRunService } from "../application/advance-run.js";
import type { RunId } from "../domain/ids.js";
import type { Clock } from "../ports/clock.js";
import type { RunStore } from "../ports/run-store.js";
import { ExecutionRegistry } from "./execution-registry.js";
import { noFaults, type FaultInjector } from "./fault-injector.js";
import { LeaseHeartbeat } from "./lease-heartbeat.js";

export interface RunWorkerOptions {
  runs: RunStore;
  advance: AdvanceRunService;
  clock: Clock;
  workerId: string;
  concurrency?: number;
  leaseDurationMs?: number;
  idleDelayMs?: number;
  executions?: ExecutionRegistry;
  faults?: FaultInjector;
  onUnexpectedRunError?(error: unknown, runId: RunId): void;
  onFatalError?(error: unknown): void;
}

export class RunWorker {
  private readonly concurrency: number;
  private readonly leaseDurationMs: number;
  private readonly idleDelayMs: number;
  private readonly executions: ExecutionRegistry;
  private readonly faults: FaultInjector;
  private readonly active = new Map<RunId, AbortController>();
  private loops: Promise<void>[] = [];
  private fatalFailures: unknown[] = [];
  private running = false;

  constructor(private readonly options: RunWorkerOptions) {
    this.concurrency = options.concurrency ?? 4;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.idleDelayMs = options.idleDelayMs ?? 50;
    this.executions = options.executions ?? new ExecutionRegistry();
    this.faults = options.faults ?? noFaults;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.fatalFailures = [];
    this.loops = Array.from(
      { length: this.concurrency },
      (_, index) => this.claimLoop(index).catch((error: unknown) => {
        this.fatalFailures.push(error);
        this.running = false;
        try {
          this.options.onFatalError?.(error);
        } catch (reportingError) {
          this.fatalFailures.push(reportingError);
        }
      }),
    );
  }

  isHealthy(): boolean {
    return this.running && this.fatalFailures.length === 0;
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
    const failure = this.fatalFailures[0];
    this.fatalFailures = [];
    if (failure !== undefined) throw failure;
  }

  private async claimLoop(index: number): Promise<void> {
    let busyDelayMs = 50;
    const leaseOwner = `${this.options.workerId}:${index}`;
    while (this.running) {
      let run;
      try {
        const now = this.options.clock.now();
        await this.faults.hit("before_run_claim");
        run = this.options.runs.claimNextEligible(
          leaseOwner,
          now,
          new Date(now.getTime() + this.leaseDurationMs),
        );
        if (run !== null) await this.faults.hit("after_run_claim");
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
      this.executions.register(run.runId, controller);
      heartbeat.start();
      let shouldBackOff = false;
      let unexpectedRunError: unknown;
      try {
        while (this.running && !controller.signal.aborted) {
          await this.faults.hit("before_worker_resume");
          const outcome = await this.options.advance.advance(run.runId, leaseOwner, controller.signal);
          await this.faults.hit("after_worker_resume");
          if (heartbeatFailure !== undefined) throw heartbeatFailure;
          busyDelayMs = 50;
          if (outcome.type !== "advanced") break;
        }
      } catch (error) {
        const cause = heartbeatFailure ?? error;
        let cancellation = null;
        let cancellationFailure: unknown;
        if (controller.signal.aborted) {
          try {
            cancellation = await this.options.advance.finalizeCancellation(
              run.runId,
              leaseOwner,
            );
          } catch (finalizationError) {
            cancellationFailure = finalizationError;
          }
        }
        if (cancellation !== null) {
          busyDelayMs = 50;
        } else if (cancellationFailure !== undefined && isLeaseLost(cancellationFailure)) {
          // Another worker owns the Run now; do not retry this cancelled lease.
        } else if (cancellationFailure !== undefined && isSqliteBusy(cancellationFailure)) {
          shouldBackOff = true;
        } else if (cancellationFailure !== undefined && !isLeaseLost(cancellationFailure)) {
          unexpectedRunError = cancellationFailure;
        } else if (isSqliteBusy(cause)) {
          shouldBackOff = true;
        } else if (heartbeatFailure !== undefined && !isLeaseLost(cause)) {
          unexpectedRunError = cause;
        } else if (!controller.signal.aborted && !isLeaseLost(cause)) {
          unexpectedRunError = cause;
        }
      } finally {
        heartbeat.stop();
        this.active.delete(run.runId);
        this.executions.unregister(run.runId, controller);
      }
      if (unexpectedRunError !== undefined) {
        this.options.onUnexpectedRunError?.(unexpectedRunError, run.runId);
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
