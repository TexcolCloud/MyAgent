import type { ApprovalId } from "../domain/ids.js";
import type { Clock } from "../ports/clock.js";

const SCAN_INTERVAL_MS = 60_000;

export interface ExpiredApprovalStore {
  listExpired(now: Date): readonly { approvalId: ApprovalId }[];
  decide(input: { approvalId: ApprovalId; decision: "expire"; occurredAt: Date }): unknown;
}

export class ApprovalExpirer {
  private controller: AbortController | undefined;
  private loop: Promise<void> | undefined;

  constructor(private readonly options: { approvals: ExpiredApprovalStore; clock: Clock }) {}

  start(): void {
    if (this.loop !== undefined) return;
    this.controller = new AbortController();
    this.loop = this.run(this.controller.signal);
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.loop;
    this.controller = undefined;
    this.loop = undefined;
  }

  async scan(): Promise<void> {
    const now = this.options.clock.now();
    for (const approval of this.options.approvals.listExpired(now)) {
      this.options.approvals.decide({ approvalId: approval.approvalId, decision: "expire", occurredAt: now });
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.scan();
      try {
        await this.options.clock.sleep(SCAN_INTERVAL_MS, signal);
      } catch {
        if (!signal.aborted) throw new Error("approval_expirer_sleep_failed");
      }
    }
  }
}
