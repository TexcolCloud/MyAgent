import type { ApprovalId } from "../domain/ids.js";
import type { Clock } from "../ports/clock.js";

const SCAN_INTERVAL_MS = 60_000;

export interface ExpiredApprovalStore {
  listExpired(now: Date): readonly { approvalId: ApprovalId }[];
  decide(input: { approvalId: ApprovalId; decision: "expire"; occurredAt: Date }): unknown;
}

export interface ApprovalExpirerOptions {
  readonly approvals: ExpiredApprovalStore;
  readonly clock: Clock;
  readonly onFatalError?: (error: unknown) => void;
}

export class ApprovalExpirer {
  private controller: AbortController | undefined;
  private loop: Promise<void> | undefined;
  private fatalFailures: unknown[] = [];
  private running = false;

  constructor(private readonly options: ApprovalExpirerOptions) {}

  start(): void {
    if (this.loop !== undefined) return;
    this.running = true;
    this.fatalFailures = [];
    this.controller = new AbortController();
    this.loop = this.run(this.controller.signal).catch((error: unknown) => {
      this.fatalFailures.push(error);
      this.running = false;
      try {
        this.options.onFatalError?.(error);
      } catch (reportingError) {
        this.fatalFailures.push(reportingError);
      }
    });
  }

  isHealthy(): boolean {
    return this.running && this.fatalFailures.length === 0;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.controller?.abort();
    await this.loop;
    this.controller = undefined;
    this.loop = undefined;
    const failure = this.fatalFailures[0];
    this.fatalFailures = [];
    if (failure !== undefined) throw failure;
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
