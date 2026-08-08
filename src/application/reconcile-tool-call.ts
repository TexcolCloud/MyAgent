import canonicalizeModule from "canonicalize";

import { ApplicationError, DomainError } from "../domain/errors.js";
import type { ToolCallId } from "../domain/ids.js";
import type { JsonValue } from "../domain/json.js";
import type { Clock } from "../ports/clock.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type { RunStore } from "../ports/run-store.js";
import type { ReconciliationStore } from "../ports/tool-store.js";
import type { PolicyEngine } from "./policy-engine.js";

const MAX_RECONCILIATION_BYTES = 64 * 1_024;
const canonicalizeJson = canonicalizeModule as unknown as (
  input: unknown,
) => string | undefined;

export type ReconciliationOutcome = "succeeded" | "failed" | "retry";

export interface ReconcileToolCallServiceOptions {
  tools: ReconciliationStore;
  runs: Pick<RunStore, "getExecutionContext">;
  policy: Pick<PolicyEngine, "decide">;
  clock: Pick<Clock, "now">;
  ids: Pick<IdGenerator, "toolCallId" | "approvalId">;
}

export class ReconcileToolCallService {
  constructor(private readonly options: ReconcileToolCallServiceOptions) {}

  execute(input: {
    toolCallId: ToolCallId;
    outcome: ReconciliationOutcome;
    note?: string;
    result?: JsonValue;
  }) {
    const note = input.note ?? "";
    const evidence = input.result === undefined
      ? { note }
      : { note, result: input.result };
    const encoded = canonicalizeJson(evidence);
    if (encoded === undefined) throw new DomainError("value_not_canonicalizable");
    if (Buffer.byteLength(encoded, "utf8") > MAX_RECONCILIATION_BYTES) {
      throw new ApplicationError("reconciliation_result_too_large", 422);
    }
    if (input.outcome === "retry") {
      if (input.result !== undefined) {
        throw new ApplicationError("reconciliation_retry_result_forbidden", 422);
      }
      const call = this.options.tools.get(input.toolCallId);
      const context = this.options.runs.getExecutionContext(call.runId);
      if (context.run.state === "cancelled") {
        throw new ApplicationError(
          "reconciliation_retry_cancelled_run",
          409,
        );
      }
      const decision = this.options.policy.decide({
        agentId: context.run.agentId,
        toolName: call.toolName,
        policy: context.revision.policy,
        policyFacts: call.policyFacts,
      });
      const occurredAt = this.options.clock.now();
      return this.options.tools.reconcile({
        toolCallId: input.toolCallId,
        outcome: "retry",
        note,
        retryToolCallId: this.options.ids.toolCallId(),
        policyEffect: decision.effect,
        matchedRule: decision.matchedRule,
        toolCallLimit: context.revision.limits.toolCalls,
        ...(decision.effect === "ask" ? {
          approvalId: this.options.ids.approvalId(),
          approvalExpiresAt: new Date(occurredAt.getTime() + 24 * 60 * 60 * 1_000),
        } : {}),
        occurredAt,
      });
    }
    return this.options.tools.reconcile({
      toolCallId: input.toolCallId,
      outcome: input.outcome,
      note,
      ...(input.result === undefined ? {} : { result: input.result }),
      occurredAt: this.options.clock.now(),
    });
  }
}
