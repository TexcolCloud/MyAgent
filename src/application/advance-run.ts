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
import { noFaults, type FaultInjector } from "../runtime/fault-injector.js";
import { DeltaBuffer } from "./delta-buffer.js";
import type { PolicyEngine } from "./policy-engine.js";
import type { PromptAssembler } from "./prompt-assembler.js";
import { SessionSummarizer } from "./session-summarizer.js";
import { normalizeToolProposal } from "./tool-proposal.js";

const MAX_MODEL_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [250, 1_000] as const;
const DELTA_MAX_DELAY_MS = 100;

export type AdvanceOutcome =
  | { type: "advanced"; runId: RunId }
  | {
      type: "waiting";
      runId: RunId;
      state: "waiting_approval" | "waiting_reconciliation" | "waiting_child";
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
  faults?: FaultInjector;
}

interface CompletedAttempt {
  text: string;
  finishReason: string;
  usage: ModelUsage;
  toolCall?: Extract<ModelChunk, { type: "tool_call" }>["call"];
}

export class AdvanceRunService {
  private readonly activeAbortSafety = new Map<RunId, boolean>();
  private readonly faults: FaultInjector;

  constructor(private readonly options: AdvanceRunServiceOptions) {
    this.faults = options.faults ?? noFaults;
  }

  isAbortSafe(runId: RunId): boolean {
    return this.activeAbortSafety.get(runId) ?? true;
  }

  finalizeCancellation(
    runId: RunId,
    leaseOwner: string,
  ): AdvanceOutcome | null {
    const context = this.options.runs.getExecutionContext(runId);
    if (context.cancellationRequestedAt === null) return null;
    const run = this.options.runs.finalizeCancellation({
      runId,
      leaseOwner,
      occurredAt: this.options.clock.now(),
    });
    return outcomeForState(run.runId, run.state);
  }

  async advance(
    runId: RunId,
    leaseOwner: string,
    signal: AbortSignal,
  ): Promise<AdvanceOutcome> {
    signal.throwIfAborted();
    let context = this.options.runs.getExecutionContext(runId);
    assertOwnedLease(context, leaseOwner, this.options.clock.now());
    if (context.run.state !== "running") {
      return outcomeForState(context.run.runId, context.run.state);
    }
    if (context.cancellationRequestedAt !== null) {
      const cancellation = this.finalizeCancellation(runId, leaseOwner);
      if (cancellation === null) throw new DomainError("run_cancellation_not_requested");
      return cancellation;
    }
    if (this.options.approvals.getPendingForRun(runId) !== null) {
      return { type: "waiting", runId, state: "waiting_approval" };
    }
    if (this.options.runs.recoverUnmatchedModelAttempt({
      runId,
      leaseOwner,
      occurredAt: this.options.clock.now(),
    }) !== null) {
      return { type: "advanced", runId };
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
      const now = this.options.clock.now();
      if (
        activeExecutionSeconds(context, now) >=
          context.revision.limits.activeExecutionSeconds ||
        context.run.budget.toolOutputBytes >=
          context.revision.limits.maxRunToolOutputBytes
      ) {
        return this.failForBudget(runId, leaseOwner, now);
      }
      const definition = this.options.registry.get(latestTool.toolName);
      if (definition === undefined) throw new DomainError("tool_not_registered");
      await this.faults.hit("before_tool_execution");
      this.options.tools.beginExecution({
        runId, toolCallId: latestTool.toolCallId, leaseOwner, occurredAt: this.options.clock.now(),
      });
      const activatedSkills = new Map<
        string,
        { skillName: string; skillVersion: number; contentSha256: string }
      >();
      let result;
      this.activeAbortSafety.set(runId, latestTool.effect !== "side_effect");
      try {
        result = await definition.execute(latestTool.arguments, {
          agentId: context.run.agentId,
          revision: context.revision,
          runId,
          toolCallId: latestTool.toolCallId,
          signal,
          leaseOwner,
          remainingRunOutputBytes: context.revision.limits.maxRunToolOutputBytes - context.run.budget.toolOutputBytes,
          activateSkill: (skillName) => {
            const skill = context.revision.skills.find((candidate) => candidate.name === skillName);
            if (skill === undefined) throw new DomainError("skill_not_available");
            activatedSkills.set(skillName, {
              skillName,
              skillVersion: skill.version,
              contentSha256: skill.contentSha256,
            });
          },
        });
      } catch {
        if (signal.aborted) throw signal.reason;
        result = {
          ok: false,
          summary: "tool_execution_failed",
          content: { code: "tool_execution_failed" },
          capturedBytes: 0,
          truncated: false,
        };
      } finally {
        this.activeAbortSafety.delete(runId);
      }
      await this.faults.hit("after_tool_execution");
      if (result.deferred === true) {
        return { type: "waiting", runId, state: "waiting_child" };
      }
      this.options.tools.completeExecution({
        runId, toolCallId: latestTool.toolCallId, leaseOwner, result,
        activatedSkills: result.ok ? [...activatedSkills.values()] : [],
        maxToolOutputBytes: context.revision.limits.maxToolOutputBytes,
        maxRunToolOutputBytes: context.revision.limits.maxRunToolOutputBytes,
        occurredAt: this.options.clock.now(),
      });
      const cancellation = this.finalizeCancellation(runId, leaseOwner);
      if (cancellation !== null) return cancellation;
      if (this.options.runs.getRun(runId).state === "failed") {
        return { type: "terminal", runId, state: "failed" };
      }
      return { type: "advanced", runId };
    }
    if (latestTool?.state === "waiting_approval") {
      return { type: "waiting", runId, state: "waiting_approval" };
    }
    if (latestTool !== null && !["succeeded", "failed", "denied"].includes(latestTool.state)) {
      throw new DomainError("tool_checkpoint_not_implemented");
    }

    const beforeModel = this.options.clock.now();
    if (
      context.run.budget.modelTurns >= context.revision.limits.modelTurns ||
      activeExecutionSeconds(context, beforeModel) >=
        context.revision.limits.activeExecutionSeconds
    ) {
      return this.failForBudget(runId, leaseOwner, beforeModel);
    }

    const promptInput = {
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
    };
    const summaryAttemptIds = new Map<number, Parameters<RunStore["appendModelDelta"]>[2]>();
    let request: ModelRequest;
    try {
      const summary = await new SessionSummarizer({
        assembler: this.options.prompts,
        sessionStore: this.options.sessions,
        model: this.options.model,
        clock: this.options.clock,
      }).ensureWithinBudget(promptInput, signal, {
        onAttemptStarted: (attemptNumber) => {
          const now = this.options.clock.now();
          const current = this.options.runs.getExecutionContext(runId);
          assertOwnedLease(current, leaseOwner, now);
          if (
            current.run.budget.modelTurns >= current.revision.limits.modelTurns ||
            activeExecutionSeconds(current, now) >=
              current.revision.limits.activeExecutionSeconds
          ) {
            this.failForBudget(runId, leaseOwner, now);
            throw new RunBudgetTerminated();
          }
          const attemptId = this.options.ids.attemptId();
          summaryAttemptIds.set(attemptNumber, attemptId);
          this.options.runs.beginModelAttempt({
            runId,
            leaseOwner,
            attemptId,
            purpose: "session_summary",
            consumeModelTurn: attemptNumber === 1,
            modelTurnLimit: current.revision.limits.modelTurns,
            occurredAt: now,
          });
        },
        onAttemptFailed: (attemptNumber, error) => {
          const attemptId = summaryAttemptIds.get(attemptNumber);
          if (attemptId === undefined) {
            throw new Error("summary_attempt_checkpoint_missing");
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
        },
        saveSummary: (summaryInput) =>
          this.options.sessions.saveSummaryWithLease({
            runId,
            leaseOwner,
            occurredAt: this.options.clock.now(),
            summary: summaryInput,
          }),
      });
      const cancellation = this.finalizeCancellation(runId, leaseOwner);
      if (cancellation !== null) return cancellation;
      request = summary.request;
      if (summary.summarized) {
        return { type: "advanced", runId };
      }
      context = this.options.runs.getExecutionContext(runId);
      assertOwnedLease(context, leaseOwner, this.options.clock.now());
    } catch (error) {
      if (error instanceof RunBudgetTerminated) {
        return { type: "terminal", runId, state: "failed" };
      }
      if (error instanceof ModelProviderError) {
        this.options.runs.failRun({
          runId,
          leaseOwner,
          code: error.code,
          occurredAt: this.options.clock.now(),
        });
        return { type: "terminal", runId, state: "failed" };
      }
      throw error;
    }

    for (let attemptNumber = 1; attemptNumber <= MAX_MODEL_ATTEMPTS; attemptNumber += 1) {
      const attemptContext = this.options.runs.getExecutionContext(runId);
      const attemptStartedAt = this.options.clock.now();
      assertOwnedLease(attemptContext, leaseOwner, attemptStartedAt);
      if (
        activeExecutionSeconds(attemptContext, attemptStartedAt) >=
          attemptContext.revision.limits.activeExecutionSeconds ||
        (attemptNumber === 1 &&
          attemptContext.run.budget.modelTurns >=
            attemptContext.revision.limits.modelTurns)
      ) {
        return this.failForBudget(runId, leaseOwner, attemptStartedAt);
      }
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
      let completed: CompletedAttempt;
      try {
        completed = await this.collectAttempt(
          runId,
          leaseOwner,
          attemptId,
          request,
          signal,
        );
      } catch (error) {
        if (signal.aborted) {
          const cancellation = this.finalizeCancellation(runId, leaseOwner);
          if (cancellation !== null) return cancellation;
          throw signal.reason;
        }
        if (!(error instanceof ModelProviderError)) {
          throw error;
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
          this.options.runs.failRun({
            runId,
            leaseOwner,
            code: providerError.code,
            occurredAt: this.options.clock.now(),
          });
          return { type: "terminal", runId, state: "failed" };
        }
        await this.options.clock.sleep(
          retryDelay(attemptNumber, providerError.retryAfterMs),
          signal,
        );
        continue;
      }
      const cancellation = this.finalizeCancellation(runId, leaseOwner);
      if (cancellation !== null) return cancellation;
      if (completed.toolCall !== undefined) {
        if (context.run.budget.toolCalls >= context.revision.limits.toolCalls) {
          const occurredAt = this.options.clock.now();
          this.options.runs.failModelAttempt({
            runId,
            leaseOwner,
            attemptId,
            code: "run_budget_exceeded",
            transient: false,
            occurredAt,
          });
          return this.failForBudget(runId, leaseOwner, occurredAt);
        }
        const proposal = await normalizeToolProposal({
          registry: this.options.registry,
          toolName: completed.toolCall.name,
          arguments: completed.toolCall.arguments,
          context: {
            agentId: context.run.agentId,
            revision: context.revision,
          },
        });
        const cancellationAfterNormalization = this.finalizeCancellation(
          runId,
          leaseOwner,
        );
        if (cancellationAfterNormalization !== null) {
          return cancellationAfterNormalization;
        }
        const decision = this.options.policy.decide({
          agentId: context.run.agentId,
          toolName: proposal.toolName,
          policy: context.revision.policy,
          policyFacts: proposal.policyFacts,
        });
        await this.faults.hit("before_model_attempt_commit");
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
        await this.faults.hit("after_model_attempt_commit");
        if (decision.effect === "ask") {
          return { type: "waiting", runId, state: "waiting_approval" };
        }
        return { type: "advanced", runId };
      }
      await this.faults.hit("before_model_attempt_commit");
      const run = this.options.runs.completeRun({
        runId,
        leaseOwner,
        attemptId,
        ...completed,
        occurredAt: this.options.clock.now(),
      });
      await this.faults.hit("after_model_attempt_commit");
      return { type: "terminal", runId, state: run.state as "completed" };
    }
    throw new Error("unreachable_model_attempt_loop");
  }

  private failForBudget(
    runId: RunId,
    leaseOwner: string,
    occurredAt: Date,
  ): AdvanceOutcome {
    this.options.runs.failRun({
      runId,
      leaseOwner,
      code: "run_budget_exceeded",
      occurredAt,
    });
    return { type: "terminal", runId, state: "failed" };
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
      maxDelayMs: DELTA_MAX_DELAY_MS,
      clock: this.options.clock,
    });
    let text = "";
    let completed: Extract<ModelChunk, { type: "completed" }> | undefined;
    let toolCall: Extract<ModelChunk, { type: "tool_call" }>["call"] | undefined;
    const stream = this.options.model.streamAttempt(request, signal);
    const iterator = stream[Symbol.asyncIterator]();
    let pendingNext: Promise<IteratorResult<ModelChunk>> | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let flushDue: Promise<"flush"> | undefined;
    const cancelFlush = (): void => {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
      }
      flushTimer = undefined;
      flushDue = undefined;
    };
    const scheduleFlush = (): void => {
      if (flushDue !== undefined) {
        return;
      }
      flushDue = new Promise((resolve) => {
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          resolve("flush");
        }, DELTA_MAX_DELAY_MS);
      });
    };
    const persistDelta = (delta: string | null): void => {
      if (delta === null) {
        return;
      }
      this.options.runs.appendModelDelta(
        runId,
        leaseOwner,
        attemptId,
        delta,
        this.options.clock.now(),
      );
    };
    try {
      while (true) {
        pendingNext ??= iterator.next();
        const nextResult = pendingNext.then((result) => ({
          type: "next" as const,
          result,
        }));
        const winner = flushDue === undefined
          ? await nextResult
          : await Promise.race([
              nextResult,
              flushDue.then(() => ({ type: "flush" as const })),
            ]);
        if (winner.type === "flush") {
          flushDue = undefined;
          persistDelta(buffer.flush());
          continue;
        }
        pendingNext = undefined;
        if (winner.result.done) {
          break;
        }
        signal.throwIfAborted();
        const chunk = winner.result.value;
        if (chunk.type === "text_delta") {
          text += chunk.text;
          const delta = buffer.push(chunk.text);
          if (delta !== null) {
            cancelFlush();
            persistDelta(delta);
          } else if (chunk.text.length > 0) {
            scheduleFlush();
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
      cancelFlush();
      persistDelta(buffer.flush());
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

function activeExecutionSeconds(
  context: ReturnType<RunStore["getExecutionContext"]>,
  now: Date,
): number {
  if (context.activeStartedAt === null) {
    return context.run.budget.activeExecutionSeconds;
  }
  const current = Math.ceil(
    Math.max(0, now.getTime() - context.activeStartedAt.getTime()) / 1_000,
  );
  return context.run.budget.activeExecutionSeconds + current;
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

class RunBudgetTerminated extends Error {}
