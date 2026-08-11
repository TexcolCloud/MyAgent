import { describe, expect, it } from "vitest";

import { ApprovalExpirer } from "../../src/runtime/approval-expirer.js";
import { approvalIdFromUuid } from "../../src/domain/ids.js";
import { FakeClock } from "../helpers/fake-clock.js";

describe("ApprovalExpirer", () => {
  it("expires pending approvals immediately and is idempotent", async () => {
    const clock = new FakeClock(new Date("2026-08-07T00:00:00.000Z"));
    const approvalId = approvalIdFromUuid("00000000-0000-7000-8000-000000000102");
    const approvals = new FakeApprovalStore(approvalId);
    const expirer = new ApprovalExpirer({ approvals, clock });

    await expirer.scan();
    await expirer.scan();

    expect(approvals.decisions).toEqual([approvalId]);
  });

  it("latches and reports a fatal loop failure", async () => {
    const failure = new Error("clock_failed");
    let reportFailure!: (error: unknown) => void;
    const reported = new Promise<unknown>((resolve) => {
      reportFailure = resolve;
    });
    const expirer = new ApprovalExpirer({
      approvals: { listExpired: () => [], decide: () => undefined },
      clock: {
        now: () => new Date("2026-08-07T00:00:00.000Z"),
        sleep: () => Promise.reject(failure),
      },
      onFatalError: reportFailure,
    });

    expirer.start();

    expect(await reported).toEqual(new Error("approval_expirer_sleep_failed"));
    expect(expirer.isHealthy()).toBe(false);
    await expect(expirer.stop()).rejects.toThrow("approval_expirer_sleep_failed");
  });
});

class FakeApprovalStore {
  readonly decisions: ReturnType<typeof approvalIdFromUuid>[] = [];
  private pending = true;

  constructor(private readonly approvalId: ReturnType<typeof approvalIdFromUuid>) {}

  listExpired(): readonly { approvalId: ReturnType<typeof approvalIdFromUuid> }[] {
    return this.pending ? [{ approvalId: this.approvalId }] : [];
  }

  decide(input: { approvalId: ReturnType<typeof approvalIdFromUuid>; decision: "expire" }): void {
    this.decisions.push(input.approvalId);
    this.pending = false;
  }
}
