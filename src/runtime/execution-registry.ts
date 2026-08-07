import type { RunId } from "../domain/ids.js";

export interface ProcessTreeHandle {
  abort(): void;
}

export class ExecutionRegistry {
  private readonly executions = new Map<RunId, { controller: AbortController; process?: ProcessTreeHandle }>();

  register(runId: RunId, controller: AbortController, process?: ProcessTreeHandle): void {
    this.executions.set(runId, process === undefined ? { controller } : { controller, process });
  }

  unregister(runId: RunId, controller?: AbortController): void {
    const current = this.executions.get(runId);
    if (current !== undefined && (controller === undefined || current.controller === controller)) {
      this.executions.delete(runId);
    }
  }

  abort(runId: RunId): boolean {
    const current = this.executions.get(runId);
    if (current === undefined) return false;
    current.controller.abort(new Error("run_cancelled"));
    current.process?.abort();
    return true;
  }
}
