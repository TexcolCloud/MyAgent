import { describe, expect, it } from "vitest";

import { M1_EVENT_TYPES } from "../../src/domain/events.js";
import {
  assertApprovalTransition,
  assertRunTransition,
  assertToolCallTransition,
} from "../../src/domain/states.js";

describe("durable state transitions", () => {
  it("makes terminal Run states immutable", () => {
    for (const state of ["completed", "failed", "cancelled"] as const) {
      expect(() => assertRunTransition(state, "running")).toThrow(
        "invalid_run_transition",
      );
    }
  });

  it("requires reconciliation before an unknown Tool Call can finish", () => {
    expect(() => assertToolCallTransition("executing", "unknown")).not.toThrow();
    expect(() => assertToolCallTransition("unknown", "succeeded")).not.toThrow();
    expect(() => assertToolCallTransition("unknown", "executing")).toThrow(
      "invalid_tool_call_transition",
    );
  });

  it("allows only one terminal Approval decision", () => {
    expect(() => assertApprovalTransition("pending", "expired")).not.toThrow();
    expect(() => assertApprovalTransition("approved", "denied")).toThrow(
      "invalid_approval_transition",
    );
  });

  it("publishes the complete approved M1 event vocabulary", () => {
    expect(M1_EVENT_TYPES).toEqual([
      "run.queued",
      "run.started",
      "run.waiting",
      "run.completed",
      "run.failed",
      "run.cancelled",
      "model.attempt.started",
      "message.delta",
      "model.attempt.failed",
      "message.completed",
      "skill.activated",
      "tool.proposed",
      "tool.policy_decided",
      "tool.started",
      "tool.completed",
      "tool.failed",
      "tool.unknown",
      "approval.required",
      "approval.resolved",
      "delegation.started",
      "delegation.completed",
      "context.degraded",
    ]);
  });
});
