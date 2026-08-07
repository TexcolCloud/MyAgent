import { DomainError } from "./errors.js";

export interface RunLimits {
  modelTurns: number;
  toolCalls: number;
  childRuns: number;
  delegationDepth: number;
  activeExecutionSeconds: number;
  defaultToolTimeoutMs: number;
  maxToolTimeoutMs: number;
  maxToolOutputBytes: number;
  maxRunToolOutputBytes: number;
}

export interface RunBudget {
  modelTurns: number;
  toolCalls: number;
  childRuns: number;
  delegationDepth: number;
  activeExecutionSeconds: number;
  toolOutputBytes: number;
}

export type BudgetDelta = Partial<RunBudget>;

export const DEFAULT_RUN_LIMITS: Readonly<RunLimits> = Object.freeze({
  modelTurns: 20,
  toolCalls: 12,
  childRuns: 4,
  delegationDepth: 1,
  activeExecutionSeconds: 900,
  defaultToolTimeoutMs: 120_000,
  maxToolTimeoutMs: 600_000,
  maxToolOutputBytes: 1_048_576,
  maxRunToolOutputBytes: 8_388_608,
});

export function consumeBudget(
  current: Readonly<RunBudget>,
  delta: Readonly<BudgetDelta>,
  limits: Readonly<RunLimits>,
): RunBudget {
  validateBudgetDelta(delta);
  const next = addBudget(current, delta);
  assertBudgetWithinLimits(next, delta, limits);
  return next;
}

function validateBudgetDelta(delta: Readonly<BudgetDelta>): void {
  for (const [field, value] of Object.entries(delta)) {
    if (value === undefined || !Number.isFinite(value) || value < 0) {
      throw new DomainError(
        "invalid_budget_delta",
        `invalid_budget_delta: ${field}`,
        { field },
      );
    }
  }
}

function addBudget(
  current: Readonly<RunBudget>,
  delta: Readonly<BudgetDelta>,
): RunBudget {
  return {
    modelTurns: current.modelTurns + (delta.modelTurns ?? 0),
    toolCalls: current.toolCalls + (delta.toolCalls ?? 0),
    childRuns: current.childRuns + (delta.childRuns ?? 0),
    delegationDepth: current.delegationDepth + (delta.delegationDepth ?? 0),
    activeExecutionSeconds:
      current.activeExecutionSeconds + (delta.activeExecutionSeconds ?? 0),
    toolOutputBytes: current.toolOutputBytes + (delta.toolOutputBytes ?? 0),
  };
}

function assertBudgetWithinLimits(
  next: Readonly<RunBudget>,
  delta: Readonly<BudgetDelta>,
  limits: Readonly<RunLimits>,
): void {
  const boundedValues = [
    ["modelTurns", next.modelTurns, limits.modelTurns],
    ["toolCalls", next.toolCalls, limits.toolCalls],
    ["childRuns", next.childRuns, limits.childRuns],
    ["delegationDepth", next.delegationDepth, limits.delegationDepth],
    [
      "activeExecutionSeconds",
      next.activeExecutionSeconds,
      limits.activeExecutionSeconds,
    ],
  ] as const;

  for (const [limit, value, maximum] of boundedValues) {
    if (value > maximum) {
      throwBudgetExceeded(limit, value, maximum);
    }
  }

  const callOutputBytes = delta.toolOutputBytes ?? 0;
  if (callOutputBytes > limits.maxToolOutputBytes) {
    throwBudgetExceeded(
      "maxToolOutputBytes",
      callOutputBytes,
      limits.maxToolOutputBytes,
    );
  }

  if (next.toolOutputBytes > limits.maxRunToolOutputBytes) {
    throwBudgetExceeded(
      "maxRunToolOutputBytes",
      next.toolOutputBytes,
      limits.maxRunToolOutputBytes,
    );
  }
}

function throwBudgetExceeded(limit: string, value: number, maximum: number): never {
  throw new DomainError(
    "run_budget_exceeded",
    `run_budget_exceeded: ${limit}`,
    { limit, value, maximum },
  );
}
