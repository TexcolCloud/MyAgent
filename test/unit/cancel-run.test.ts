import { describe, expect, it } from "vitest";

import { CancelRunService } from "../../src/application/cancel-run.js";
import { ExecutionRegistry } from "../../src/runtime/execution-registry.js";
import { runIdFromUuid } from "../../src/domain/ids.js";

describe("CancelRunService", () => {
  it("persists cancellation before aborting in-memory work", () => {
    const calls: string[] = [];
    const registry = new ExecutionRegistry();
    const runId = runIdFromUuid("00000000-0000-7000-8000-000000000301");
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => calls.push("aborted"));
    registry.register(runId, controller);
    const service = new CancelRunService({
      cancel: () => { calls.push("persisted"); return { runId, state: "cancelled" }; },
    }, registry, { now: () => new Date(0) });

    service.execute({ runId });

    expect(calls).toEqual(["persisted", "aborted"]);
  });
});
