import type { RunId } from "./ids.js";
import type { JsonValue } from "./json.js";

export const M1_EVENT_TYPES = [
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
] as const;

export type RunEventType = (typeof M1_EVENT_TYPES)[number];

export interface RunEvent {
  runId: RunId;
  sequence: number;
  type: RunEventType;
  occurredAt: Date;
  payload: JsonValue;
}
