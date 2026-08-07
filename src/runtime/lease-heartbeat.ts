import type { RunId } from "../domain/ids.js";
import { DomainError } from "../domain/errors.js";
import type { Clock } from "../ports/clock.js";
import type { RunStore } from "../ports/run-store.js";

export class LeaseHeartbeat {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly runs: RunStore,
    private readonly clock: Clock,
    private readonly runId: RunId,
    private readonly leaseOwner: string,
    private readonly leaseDurationMs: number,
    private readonly onFailure: (error: unknown) => void = () => undefined,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      try {
        const now = this.clock.now();
        const renewed = this.runs.renewLease(
          this.runId,
          this.leaseOwner,
          new Date(now.getTime() + this.leaseDurationMs),
        );
        if (!renewed) throw new DomainError("run_lease_lost");
      } catch (error) {
        this.stop();
        this.onFailure(error);
      }
    }, Math.max(1, Math.floor(this.leaseDurationMs / 3)));
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
