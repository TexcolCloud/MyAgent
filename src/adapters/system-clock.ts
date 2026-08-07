import { setTimeout as delay } from "node:timers/promises";

import type { Clock } from "../ports/clock.js";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal === undefined) {
      await delay(milliseconds);
      return;
    }

    await delay(milliseconds, undefined, { signal });
  }
}
