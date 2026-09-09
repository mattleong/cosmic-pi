import { describe, expect, it } from "vitest";
import { schedule } from "../../eval/pilot.ts";
import { compareFormatter } from "../../eval/formatter-score.ts";
import { formatterTasks } from "../../eval/formatter-tasks.ts";
import { freshFormatterMeasurements } from "../../eval/formatter.ts";
import type { RunRecord } from "../../eval/score.ts";

const records = (): RunRecord[] =>
  schedule("formatter", 24).map(({ task, variant, repetition }) => ({
    task: task.id,
    split: task.split,
    eligible: task.eligible,
    variant,
    repetition,
    correct: true,
    completed: true,
    codeModeCalls: task.eligible ? 1 : 0,
    codeModeErrors: 0,
    directToolErrors: 0,
    nestedCalls: task.eligible ? 3 : 0,
    nestedSucceeded: task.eligible ? 3 : 0,
    nestedErrors: 0,
    nestedOutputBytes: 1000,
    toolResultBytes: task.eligible ? (variant === "baseline" ? 200 : 100) : 64,
    codeModeToolResultBytes: task.eligible ? (variant === "baseline" ? 200 : 100) : 0,
    directToolResultBytes: task.eligible ? 0 : 64,
    outerCalls: 1,
    turns: 2,
    inputTokens: task.eligible && variant === "candidate" ? 400 : 500,
    outputTokens: 100,
    cacheReadTokens: 500,
    cacheWriteTokens: 0,
    estimatedCost: 0.01,
    elapsedMs: 100,
    boundaryViolations: 0,
    codeModeTruncations: 0,
    nativeTruncations: 0,
    formatter: task.eligible
      ? {
          ...freshFormatterMeasurements(),
          calls: 1,
          structuredCalls: 1,
          changedCalls: 1,
          prettyBytes: 200,
          compactBytes: 100,
        }
      : freshFormatterMeasurements(),
  }));
const change = (patch: Partial<RunRecord>) =>
  records().map((run) =>
    run.variant === "candidate" && run.eligible ? { ...run, ...patch } : run,
  );

describe("formatter end-to-end scoring", () => {
  it("uses reproducible task blocks, adjacent pairs, and balanced first arms", () => {
    for (const cap of [24, 48] as const) {
      const plan = schedule("formatter", cap);
      expect(plan).toEqual(schedule("formatter", cap));
      expect(plan).toHaveLength(cap);
      expect(new Set(plan.map((r) => `${r.task.id}:${r.variant}:${r.repetition}`)).size).toBe(cap);
      for (let n = 0; n < plan.length; n += 2) {
        expect(plan[n]!.task.id).toBe(plan[n + 1]!.task.id);
        expect(plan[n]!.variant).not.toBe(plan[n + 1]!.variant);
      }
      for (const task of formatterTasks) {
        const first = plan.filter((run, n) => n % 2 === 0 && run.task.id === task.id);
        expect(first.filter((run) => run.variant === "baseline")).toHaveLength(cap / 24);
      }
    }
  });

  it("distinguishes byte-only savings from whole-session token savings", () => {
    expect(compareFormatter(records(), 12).verdict).toBe("pilot-token-benefit");
    const bytesOnly = compareFormatter(change({ inputTokens: 500 }), 12);
    expect(bytesOnly.byteTargetMet).toBe(true);
    expect(bytesOnly.tokenTargetMet).toBe(false);
    expect(bytesOnly.verdict).toBe("bytes-only");
    expect(compareFormatter(change({ cacheReadTokens: 1000 }), 12).tokenTargetMet).toBe(false);
  });

  it("keeps string and bypass episodes instead of selecting only exposed successes", () => {
    const unexposed = records().map((run) =>
      run.eligible
        ? {
            ...run,
            formatter: {
              ...freshFormatterMeasurements(),
              calls: 1,
              stringCalls: 1,
              prettyBytes: 100,
              compactBytes: 100,
            },
          }
        : run,
    );
    const report = compareFormatter(unexposed, 12);
    expect(report.baseline.sessions).toBe(8);
    expect(report.candidate.sessions).toBe(8);
    expect(report.verdict).toBe("insufficient-exposure");
  });

  it("requires complete scheduled identities and rejects failures or formatter clamps", () => {
    expect(compareFormatter(records().slice(1), 12).complete).toBe(false);
    expect(
      compareFormatter(
        records().map((r) => (r.task === "FC1" ? { ...r, task: "foreign" } : r)),
        12,
      ).complete,
    ).toBe(false);
    for (const patch of [
      { correct: false },
      { completed: false },
      { codeModeErrors: 1 },
      { nestedErrors: 1 },
      { directToolErrors: 1 },
      { boundaryViolations: 1 },
      { codeModeTruncations: 1 },
      { nativeTruncations: 1 },
    ])
      expect(compareFormatter(change(patch), 12).candidateValid).toBe(false);
    const clipped = records().map((run) =>
      run.variant === "candidate"
        ? { ...run, formatter: { ...run.formatter!, clampedCalls: 1 } }
        : run,
    );
    expect(compareFormatter(clipped, 12).candidateValid).toBe(false);
  });

  it("does not buy token savings with extra turns, output tokens, or control work", () => {
    for (const patch of [
      { turns: 3 },
      { outerCalls: 2 },
      { outputTokens: 120 },
      { elapsedMs: 200 },
    ])
      expect(compareFormatter(change(patch), 12).noCompensatingWork).toBe(false);
    const controls = records().map((run) =>
      run.variant === "candidate" && !run.eligible ? { ...run, inputTokens: 1000 } : run,
    );
    expect(compareFormatter(controls, 12).noControlRegression).toBe(false);
    expect(compareFormatter(controls, 12).verdict).toBe("work-guard-failed");
  });
});
