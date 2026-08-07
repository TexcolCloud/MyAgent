import type { Clock } from "../../src/ports/clock.js";

export class FakeClock implements Clock {
  private currentMilliseconds: number;

  constructor(initial: Date = new Date(0)) {
    this.currentMilliseconds = initial.getTime();
  }

  now(): Date {
    return new Date(this.currentMilliseconds);
  }

  advanceBy(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new Error("invalid_clock_advance");
    }

    this.currentMilliseconds += milliseconds;
  }

  async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      throw signal.reason;
    }

    this.advanceBy(milliseconds);
  }
}
