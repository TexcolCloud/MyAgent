import { describe, expect, it } from "vitest";

import {
  consumeBudget,
  DEFAULT_RUN_LIMITS,
  type RunBudget,
} from "../../src/domain/limits.js";

const EMPTY_BUDGET: RunBudget = {
  modelTurns: 0,
  toolCalls: 0,
  childRuns: 0,
  delegationDepth: 0,
  activeExecutionSeconds: 0,
  toolOutputBytes: 0,
};

describe("Run limits", () => {
  it("uses the approved M1 defaults", () => {
    expect(DEFAULT_RUN_LIMITS).toEqual({
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
  });

  it("returns an accumulated budget without mutating prior state", () => {
    const next = consumeBudget(
      EMPTY_BUDGET,
      {
        modelTurns: 1,
        toolCalls: 1,
        activeExecutionSeconds: 12,
        toolOutputBytes: 256,
      },
      DEFAULT_RUN_LIMITS,
    );

    expect(next).toEqual({
      ...EMPTY_BUDGET,
      modelTurns: 1,
      toolCalls: 1,
      activeExecutionSeconds: 12,
      toolOutputBytes: 256,
    });
    expect(EMPTY_BUDGET).toEqual({
      modelTurns: 0,
      toolCalls: 0,
      childRuns: 0,
      delegationDepth: 0,
      activeExecutionSeconds: 0,
      toolOutputBytes: 0,
    });
  });

  it("rejects every hard Run limit with a typed budget error", () => {
    const cases: readonly [string, RunBudget, Parameters<typeof consumeBudget>[1]][] = [
      ["modelTurns", EMPTY_BUDGET, { modelTurns: 21 }],
      ["toolCalls", EMPTY_BUDGET, { toolCalls: 13 }],
      ["childRuns", EMPTY_BUDGET, { childRuns: 5 }],
      ["delegationDepth", EMPTY_BUDGET, { delegationDepth: 2 }],
      ["activeExecutionSeconds", EMPTY_BUDGET, { activeExecutionSeconds: 901 }],
      ["maxToolOutputBytes", EMPTY_BUDGET, { toolOutputBytes: 1_048_577 }],
      [
        "maxRunToolOutputBytes",
        { ...EMPTY_BUDGET, toolOutputBytes: 8_388_600 },
        { toolOutputBytes: 9 },
      ],
    ];

    for (const [limit, current, delta] of cases) {
      let caught: unknown;
      try {
        consumeBudget(current, delta, DEFAULT_RUN_LIMITS);
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({
        code: "run_budget_exceeded",
        details: { limit },
      });
    }
  });

  it("rejects negative and non-finite budget deltas", () => {
    for (const delta of [
      { modelTurns: -1 },
      { activeExecutionSeconds: Number.NaN },
    ]) {
      let caught: unknown;
      try {
        consumeBudget(EMPTY_BUDGET, delta, DEFAULT_RUN_LIMITS);
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({ code: "invalid_budget_delta" });
    }
  });
});
