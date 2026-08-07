import { describe, expect, it } from "vitest";

import { runIdFromUuid } from "../../src/domain/ids.js";
import type { RunStore } from "../../src/ports/run-store.js";
import { LeaseHeartbeat } from "../../src/runtime/lease-heartbeat.js";
import { FakeClock } from "../helpers/fake-clock.js";

describe("LeaseHeartbeat", () => {
  it("reports a lost lease when renewal returns false", async () => {
    const runs = {
      renewLease: () => false,
    } as unknown as RunStore;
    const failures: unknown[] = [];
    const heartbeat = new LeaseHeartbeat(
      runs,
      new FakeClock(new Date("2026-08-07T00:00:00.000Z")),
      runIdFromUuid("00000000-0000-7000-8000-000000000161"),
      "worker-heartbeat",
      3,
      (error) => failures.push(error),
    );

    heartbeat.start();
    await waitFor(() => failures.length === 1);
    heartbeat.stop();

    expect(failures[0]).toMatchObject({ code: "run_lease_lost" });
  });

  it("reports renewal exceptions instead of throwing from the timer", async () => {
    const busyError = Object.assign(new Error("database is locked"), {
      errcode: 5,
    });
    const runs = {
      renewLease: () => {
        throw busyError;
      },
    } as unknown as RunStore;
    const failures: unknown[] = [];
    const heartbeat = new LeaseHeartbeat(
      runs,
      new FakeClock(new Date("2026-08-07T00:00:00.000Z")),
      runIdFromUuid("00000000-0000-7000-8000-000000000162"),
      "worker-heartbeat",
      3,
      (error) => failures.push(error),
    );

    heartbeat.start();
    await waitFor(() => failures.length === 1);
    heartbeat.stop();

    expect(failures[0]).toBe(busyError);
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 200;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed_out_waiting_for_heartbeat");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
