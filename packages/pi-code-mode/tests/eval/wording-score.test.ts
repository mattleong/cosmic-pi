import { describe, expect, it } from "vitest";
import { schedule } from "../../eval/schedule.ts";
import { buildCodeModeToolDefinition } from "../../src/tools/controller.ts";
import type { RunRecord } from "../../eval/score.ts";
import { compareWording } from "../../eval/wording-score.ts";
import { wordingTasks } from "../../eval/wording-tasks.ts";
import { frozenWordingGuidelines, wordingGuidelines } from "../../eval/wording.ts";

const runs = (): RunRecord[] =>
  schedule("wording", 24).map(({ task, variant, repetition }) => ({
    task: task.id,
    split: task.split,
    eligible: task.eligible,
    variant,
    repetition,
    correct: true,
    completed: true,
    codeModeCalls: 1,
    codeModeErrors: 0,
    directToolErrors: 0,
    nestedCalls: 2,
    nestedSucceeded: 2,
    nestedErrors: 0,
    nestedOutputBytes: 100,
    toolResultBytes: 100,
    codeModeToolResultBytes: 100,
    directToolResultBytes: 0,
    outerCalls: task.eligible && variant === "baseline" ? 2 : 1,
    turns: task.eligible && variant === "baseline" ? 3 : 2,
    inputTokens: 100,
    outputTokens: 100,
    cacheReadTokens: 100,
    cacheWriteTokens: 0,
    estimatedCost: 0.01,
    elapsedMs: 100,
    boundaryViolations: 0,
    codeModeTruncations: 0,
    nativeTruncations: 0,
  }));
const changeCandidates = (change: Partial<RunRecord>) =>
  runs().map((run) => (run.variant === "candidate" ? { ...run, ...change } : run));

describe("frozen wording comparison", () => {
  it("balances arm order per task without exceeding either declared plan", () => {
    for (const cap of [24, 48] as const) {
      const plan = schedule("wording", cap);
      expect(plan).toHaveLength(cap);
      for (const task of wordingTasks) {
        const episodes = plan.filter((episode) => episode.task.id === task.id);
        const firstArms = episodes.filter((_, index) => index % 2 === 0);
        expect(firstArms.filter((episode) => episode.variant === "baseline")).toHaveLength(
          cap / 24,
        );
        expect(
          new Set(episodes.map((episode) => `${episode.repetition}:${episode.variant}`)).size,
        ).toBe(cap / 6);
      }
    }
  });

  it("replays both historical arms without changing restored production guidance", () => {
    const live = buildCodeModeToolDefinition({
      catalogBudget: 0,
      includePowerShell: false,
      execute: () => Promise.reject(new Error("not executed")),
    }).promptGuidelines!;
    expect(live).toEqual(frozenWordingGuidelines.baseline);
    for (const production of [live, frozenWordingGuidelines.candidate]) {
      for (const variant of ["baseline", "candidate"] as const) {
        expect(wordingGuidelines(production, variant)).toEqual(frozenWordingGuidelines[variant]);
      }
    }
    expect(live).toEqual(frozenWordingGuidelines.baseline);
  });

  it("refuses drift in selection, intent, or output guidance before replay", () => {
    for (const variant of ["baseline", "candidate"] as const) {
      const snapshot = frozenWordingGuidelines[variant];
      for (let index = 0; index < snapshot.length; index++) {
        const changed: string[] = [...snapshot];
        changed[index] = "unreviewed guidance";
        expect(() => wordingGuidelines(changed, variant)).toThrow();
      }
      expect(() => wordingGuidelines([...snapshot, "another rule"], variant)).toThrow();
    }
  });

  it("rewards fewer turns, not more Code Mode calls, and reports a turn floor", () => {
    const improved = compareWording(runs(), 12);
    expect(improved.verdict).toBe("pilot-threshold-met");
    expect(improved.taskBalancedTurnReduction).toBeCloseTo(1 / 3);
    const floor = compareWording(
      runs().map((run) => ({ ...run, turns: 2 })),
      12,
    );
    expect(floor.baselineAtTurnFloor).toBe(true);
    expect(floor.verdict).toBe("target-not-met");
    expect(floor.totalTurnReduction).toBe(0);
  });

  it("weights each task and repetition equally rather than letting one long run dominate", () => {
    const records = runs().map((run) => ({
      ...run,
      turns: run.variant === "baseline" && run.task === "WB1" ? 100 : 2,
    }));
    const report = compareWording(records, 12);
    expect(report.taskBalancedTurnReduction).toBeCloseTo(0.98 / 4);
    expect(report.totalTurnReduction).toBeGreaterThan(0.9);
  });

  it("refuses missing, duplicate, foreign, or reclassified task pairs", () => {
    expect(compareWording(runs().slice(1), 12).complete).toBe(false);
    const duplicate = runs();
    duplicate[0] = duplicate.find(
      (run) => run.task === "WB2" && run.variant === duplicate[0]!.variant,
    )!;
    expect(compareWording(duplicate, 12).complete).toBe(false);
    expect(
      compareWording(
        runs().map((run) => (run.task === "WB1" ? { ...run, task: "foreign" } : run)),
        12,
      ).complete,
    ).toBe(false);
    expect(
      compareWording(
        runs().map((run) => (run.task === "WB6" ? { ...run, eligible: true } : run)),
        12,
      ).complete,
    ).toBe(false);
  });

  it("keeps errors, incomplete answers, access violations, and truncations in the result", () => {
    for (const bad of [
      { codeModeErrors: 1 },
      { nestedErrors: 1 },
      { directToolErrors: 1 },
      { correct: false },
      { completed: false },
      { boundaryViolations: 1 },
      { codeModeTruncations: 1 },
      { nativeTruncations: 1 },
    ]) {
      const report = compareWording(changeCandidates(bad), 12);
      expect(report.candidateValid).toBe(false);
      expect(report.verdict).toBe("regression");
    }
    const legacy = runs().map((run) => {
      const row = { ...run };
      delete row.directToolErrors;
      return row;
    });
    expect(compareWording(legacy, 12).candidateValid).toBe(false);
    expect(
      compareWording(
        runs().map((run) => (run.variant === "baseline" ? { ...run, correct: false } : run)),
        12,
      ).verdict,
    ).toBe("invalid-baseline");
  });

  it("rejects compensating work, including cached tokens and control-only regressions", () => {
    for (const extra of [
      { outerCalls: 3 },
      { toolResultBytes: 200 },
      { cacheReadTokens: 1000 },
      { outputTokens: 300 },
      { elapsedMs: 200 },
    ])
      expect(compareWording(changeCandidates(extra), 12).noCompensatingWork).toBe(false);
    const controlWork = runs().map((run) =>
      run.variant === "candidate" && !run.eligible ? { ...run, turns: 3 } : run,
    );
    const report = compareWording(controlWork, 12);
    expect(report.targetMet).toBe(true);
    expect(report.noControlRegression).toBe(false);
    expect(report.verdict).toBe("target-not-met");
  });
});
