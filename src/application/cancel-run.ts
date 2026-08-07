import type { RunId } from "../domain/ids.js";
import type { Clock } from "../ports/clock.js";
import type { ExecutionRegistry } from "../runtime/execution-registry.js";

export interface RunCancellationStore {
  cancel(input: { runId: RunId; occurredAt: Date }): unknown;
}

export class CancelRunService {
  constructor(
    private readonly runs: RunCancellationStore,
    private readonly executions: ExecutionRegistry,
    private readonly clock: Pick<Clock, "now">,
  ) {}

  execute(input: { runId: RunId }): unknown {
    const result = this.runs.cancel({ runId: input.runId, occurredAt: this.clock.now() });
    this.executions.abort(input.runId);
    return result;
  }
}
