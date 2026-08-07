import type { ToolCallId } from "../domain/ids.js";
import type { JsonValue } from "../domain/json.js";
import type { Clock } from "../ports/clock.js";

export type ReconciliationOutcome = "succeeded" | "failed" | "retry";

export interface ReconciliationStore {
  reconcile(input: {
    toolCallId: ToolCallId;
    outcome: ReconciliationOutcome;
    note?: string;
    result?: JsonValue;
    retryToolCallId?: ToolCallId;
    occurredAt: Date;
  }): { toolCall: { toolCallId: ToolCallId; state: string }; retryToolCallId?: ToolCallId };
}

export class ReconcileToolCallService {
  constructor(
    private readonly tools: ReconciliationStore,
    private readonly dependencies: Pick<Clock, "now"> & { toolCallId(): ToolCallId },
  ) {}

  execute(input: {
    toolCallId: ToolCallId;
    outcome: ReconciliationOutcome;
    note?: string;
    result?: JsonValue;
  }) {
    return this.tools.reconcile({
      ...input,
      ...(input.outcome === "retry" ? { retryToolCallId: this.dependencies.toolCallId() } : {}),
      occurredAt: this.dependencies.now(),
    });
  }
}
