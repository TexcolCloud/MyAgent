import type { RunId } from "../domain/ids.js";
import { DomainError } from "../domain/errors.js";
import type { JsonValue } from "../domain/json.js";
import type { RunState } from "../domain/states.js";
import type { ApprovalStore } from "../ports/approval-store.js";
import type { Clock } from "../ports/clock.js";
import type { IdGenerator } from "../ports/id-generator.js";
import {
  ModelProviderError,
  type ModelChunk,
  type ModelPort,
  type ModelRequest,
  type ModelUsage,
} from "../ports/model.js";
import type { RunStore } from "../ports/run-store.js";
import type { SessionStore } from "../ports/session-store.js";
import type { ToolStore } from "../ports/tool-store.js";
import type { ToolDefinition } from "../ports/tool.js";
import type { ToolRegistry } from "../adapters/tools/registry.js";
import { DeltaBuffer } from "./delta-buffer.js";
import type { PolicyEngine } from "./policy-engine.js";
import type { PromptAssembler } from "./prompt-assembler.js";
import { normalizeToolProposal } from "./tool-proposal.js";

const MAX_MODEL_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [250, 1_000] as const;

export type AdvanceOutcome =
  | { type: "advanced"; runId: RunId }
  | {
      type: "waiting";
      runId: RunId;
      state: "waiting_approval" | "waiting_reconciliation";
    }
  | {
      type: "terminal";
      runId: RunId;
      state: Extract<RunState, "completed" | "failed" | "cancelled">;
    };

export interface AdvanceRunServiceOptions {
  runs: RunStore;
  tools: ToolStore;
  approvals: ApprovalStore;
  sessions: SessionStore;
  model: ModelPort;
  prompts: PromptAssembler;
  registry: ToolRegistry;
  policy: PolicyEngine;
  clock: Clock;
  ids: IdGenerator;
}

interface CompletedAttempt {
  text: string;
  finishReason: string;
  usage: ModelUsage;
  toolCall?: Extract<ModelChunk, { type: "tool_call" }>["call"];
}

export class AdvanceRunService {
  constructor(private readonly options: AdvanceRunServiceOptions) {}

  async advance(
    runId: RunId,
    leaseOwner: string,
    signal: AbortSignal,
  ): Promise<AdvanceOutcome> {
    signal.throwIfAborted();
    const context = this.options.runs.getExecutionContext(runId);
    assertOwnedLease(context, leaseOwner, this.options.clock.now());
    if (context.run.state !== "running") {
      return outcomeForState(context.run.runId, context.run.state);
    }
    if (this.options.approvals.getPendingForRun(runId) !== null) {
      return { type: "waiting", runId, state: "waiting_approval" };
    }
    const latestTool = this.options.tools.getLatestForRun(runId);
    if (latestTool?.state === "executing") {
      const recovered = this.options.tools.recoverExecuting({
        runId, toolCallId: latestTool.toolCallId, leaseOwner, occurredAt: this.options.clock.now(),
      });
      return recovered === "reconciliation"
        ? { type: "waiting", runId, state: "waiting_reconciliation" }
        : { type: "advanced", runId };
    }
    if (latestTool?.state === "allowed") {
      const definition = this.options.registry.get(latestTool.toolName);
      if (definition === undefined) throw new DomainError("tool_not_registered");
      this.options.tools.beginExecution({
        runId, toolCallId: latestTool.toolCallId, leaseOwner, occurredAt: this.options.clock.now(),
      });
      let result;
      try {
        result = await definition.execute(latestTool.arguments, {
          agentId: context.run.agentId,
          revision: context.revision,
          runId,
          toolCallId: latestTool.toolCallId,
          signal,
          remainingRunOutputBytes: context.revision.limits.maxRunToolOutputBytes - context.run.budget.toolOutputBytes,
          activateSkill: () => {},
        });
      } catch (error) {
        result = { ok: false, summary: error instanceof Error ? error.message : "tool_execution_failed", content: {}, capturedBytes: 0, truncated: false };
      }
      this.options.tools.completeExecution({
        runId, toolCallId: latestTool.toolCallId, leaseOwner, result,
        maxToolOutputBytes: context.revision.limits.maxToolOutputBytes,
        maxRunToolOutputBytes: context.revision.limits.maxRunToolOutputBytes,
        occurredAt: this.options.clock.now(),
      });
      return { type: "advanced", runId };
    }
    if (latestTool?.state === "waiting_approval") {
      return { type: "waiting", runId, state: "waiting_approval" };
    }
    if (latestTool !== null && !["succeeded", "failed", "denied"].includes(latestTool.state)) {
      throw new DomainError("tool_checkpoint_not_implemented");
    }

    const request = await this.options.prompts.build({
      revision: context.revision,
      sessionId: context.run.sessionId,
      runId,
      runFifoSequence: context.run.fifoSequence,
      input: context.input,
      activatedSkillNames: this.options.runs.listActivatedSkillNames(runId),
      toolResults: latestTool === null ? [] : [{
        toolName: latestTool.toolName,
        content: latestTool.result ?? { code: "tool_denied", toolName: latestTool.toolName },
      }],
      tools: modelToolDefinitions(this.options.registry),
    });

    for (let attemptNumber = 1; attemptNumber <= MAX_MODEL_ATTEMPTS; attemptNumber += 1) {
      const attemptId = this.options.ids.attemptId();
      this.options.runs.beginModelAttempt({
        runId,
        leaseOwner,
        attemptId,
        purpose: request.purpose,
        consumeModelTurn: attemptNumber === 1,
        modelTurnLimit: context.revision.limits.modelTurns,
        occurredAt: this.options.clock.now(),
      });
      try {
        const completed = await this.collectAttempt(
          runId,
          leaseOwner,
          attemptId,
          request,
          signal,
        );
        if (completed.toolCall !== undefined) {
          const proposal = await normalizeToolProposal({
            registry: this.options.registry,
            toolName: completed.toolCall.name,
            arguments: completed.toolCall.arguments,
            context: {
              agentId: context.run.agentId,
              revision: context.revision,
            },
          });
          const decision = this.options.policy.decide({
            agentId: context.run.agentId,
            toolName: proposal.toolName,
            policy: context.revision.policy,
            policyFacts: proposal.policyFacts,
          });
          this.options.tools.recordProposal({
            runId,
            leaseOwner,
            toolCallId: this.options.ids.toolCallId(),
            toolName: proposal.toolName,
            effect: proposal.effect,
            arguments: proposal.arguments,
            canonicalArguments: proposal.canonicalArguments,
            argumentsSha256: proposal.argumentsSha256,
            policyFacts: proposal.policyFacts,
            policyEffect: decision.effect,
            matchedRule: decision.matchedRule,
            toolCallLimit: context.revision.limits.toolCalls,
            ...(decision.effect === "ask" ? {
              approvalId: this.options.ids.approvalId(),
              approvalExpiresAt: new Date(this.options.clock.now().getTime() + 24 * 60 * 60 * 1_000),
            } : {}),
            occurredAt: this.options.clock.now(),
          });
          if (decision.effect === "ask") {
            return { type: "waiting", runId, state: "waiting_approval" };
          }
          return { type: "advanced", runId };
        }
        const run = this.options.runs.completeRun({
          runId,
          leaseOwner,
          attemptId,
          ...completed,
          occurredAt: this.options.clock.now(),
        });
        return { type: "terminal", runId, state: run.state as "completed" };
      } catch (error) {
        if (signal.aborted) {
          throw signal.reason;
        }
        const providerError = asProviderError(error);
        this.options.runs.failModelAttempt({
          runId,
          leaseOwner,
          attemptId,
          code: providerError.code,
          transient: providerError.transient,
          occurredAt: this.options.clock.now(),
        });
        if (!providerError.transient || attemptNumber === MAX_MODEL_ATTEMPTS) {
          throw providerError;
        }
        await this.options.clock.sleep(
          retryDelay(attemptNumber, providerError.retryAfterMs),
          signal,
        );
      }
    }
    throw new Error("unreachable_model_attempt_loop");
  }

  private async collectAttempt(
    runId: RunId,
    leaseOwner: string,
    attemptId: Parameters<RunStore["appendModelDelta"]>[2],
    request: Parameters<ModelPort["streamAttempt"]>[0],
    signal: AbortSignal,
  ): Promise<CompletedAttempt> {
    const buffer = new DeltaBuffer({
      maxBytes: 1_024,
      maxDelayMs: 100,
      clock: this.options.clock,
    });
    let text = "";
    let completed: Extract<ModelChunk, { type: "completed" }> | undefined;
    let toolCall: Extract<ModelChunk, { type: "tool_call" }>["call"] | undefined;
    try {
      for await (const chunk of this.options.model.streamAttempt(request, signal)) {
        if (chunk.type === "text_delta") {
          text += chunk.text;
          const delta = buffer.push(chunk.text);
          if (delta !== null) {
            this.options.runs.appendModelDelta(
              runId,
              leaseOwner,
              attemptId,
              delta,
              this.options.clock.now(),
            );
          }
        } else if (chunk.type === "tool_call") {
          if (toolCall !== undefined) {
            throw protocolError();
          }
          toolCall = chunk.call;
        } else if (completed === undefined) {
          completed = chunk;
        } else {
          throw protocolError();
        }
      }
    } finally {
      const remaining = buffer.flush();
      if (remaining !== null) {
        this.options.runs.appendModelDelta(
          runId,
          leaseOwner,
          attemptId,
          remaining,
          this.options.clock.now(),
        );
      }
    }
    if (completed === undefined || (text.length === 0 && toolCall === undefined)) {
      throw protocolError();
    }
    return {
      text,
      finishReason: completed.finishReason,
      usage: completed.usage,
      ...(toolCall === undefined ? {} : { toolCall }),
    };
  }
}

function assertOwnedLease(
  context: ReturnType<RunStore["getExecutionContext"]>,
  leaseOwner: string,
  now: Date,
): void {
  if (
    context.leaseOwner !== leaseOwner ||
    context.leaseExpiresAt === null ||
    context.leaseExpiresAt <= now
  ) {
    throw new DomainError("run_lease_lost");
  }
}

function outcomeForState(runId: RunId, state: RunState): AdvanceOutcome {
  if (state === "waiting_approval" || state === "waiting_reconciliation") {
    return { type: "waiting", runId, state };
  }
  if (state === "completed" || state === "failed" || state === "cancelled") {
    return { type: "terminal", runId, state };
  }
  throw new DomainError("run_not_advanceable");
}

function asProviderError(error: unknown): ModelProviderError {
  return error instanceof ModelProviderError
    ? error
    : new ModelProviderError({
        transient: false,
        code: "model_protocol_error",
      });
}

function protocolError(): ModelProviderError {
  return new ModelProviderError({
    transient: false,
    code: "model_protocol_error",
  });
}

function retryDelay(attempt: number, retryAfterMs: number | undefined): number {
  return Math.min(
    30_000,
    Math.max(RETRY_DELAYS_MS[attempt - 1] ?? 1_000, retryAfterMs ?? 0),
  );
}

function modelToolDefinitions(registry: ToolRegistry): ModelRequest["tools"] {
  return registry.list().map((tool) => {
    const metadata = tool as ToolDefinition & {
      readonly description?: string;
      readonly inputSchema?: JsonValue;
    };
    return {
      name: tool.name,
      description: metadata.description ?? `Tool ${tool.name}`,
      inputSchema: metadata.inputSchema ?? { type: "object" },
    };
  });
}
