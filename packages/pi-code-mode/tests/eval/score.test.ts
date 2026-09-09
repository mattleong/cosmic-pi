import { describe, expect, it } from "vitest";
import { adopted, checkAnswer, compare, type RunRecord } from "../../eval/score.ts";
import { schedule } from "../../eval/schedule.ts";
import { tasks } from "../../eval/tasks.ts";

const run = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  task: "H1",
  split: "held-out",
  eligible: true,
  variant: "baseline",
  repetition: 0,
  correct: true,
  completed: true,
  codeModeCalls: 1,
  codeModeErrors: 0,
  nestedCalls: 2,
  nestedSucceeded: 2,
  nestedErrors: 0,
  nestedOutputBytes: 100,
  toolResultBytes: 20,
  outerCalls: 1,
  turns: 2,
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedCost: 0,
  elapsedMs: 1000,
  boundaryViolations: 0,
  codeModeTruncations: 0,
  nativeTruncations: 0,
  ...overrides,
});
const pairs = (count: number, baselineAdoptions: number): RunRecord[] =>
  Array.from({ length: count }, (_, index) => [
    run({ task: `H${index}`, codeModeCalls: index < baselineAdoptions ? 1 : 0 }),
    run({ task: `H${index}`, variant: "candidate" }),
  ]).flat();

describe("pilot scoring", () => {
  it("measures relative adoption without rewarding empty calls or counting an episode twice", () => {
    expect(adopted(run({ nestedCalls: 0, codeModeCalls: 20 }))).toBe(false);
    const result = compare(pairs(10, 9), 10);
    expect(result.verdict).toBe("pilot-threshold-met");
    expect(result.relativeIncrease).toBeCloseTo(1 / 9);
    expect(result.absoluteIncrease).toBeCloseTo(0.1);
    expect(compare(pairs(16, 15), 16)).toMatchObject({ ceilingBlocked: true, targetMet: false });
  });
  it("retains failures in denominators and refuses correctness regressions", () => {
    const records = pairs(10, 9);
    records[19] = run({ task: "H9", variant: "candidate", correct: false });
    expect(compare(records, 10)).toMatchObject({
      verdict: "regression",
      candidate: { eligibleSessions: 10, adoptionRate: 1 },
    });
  });
  it("cannot pass with missing, duplicate, failed, or useless episodes", () => {
    expect(compare(pairs(10, 9).slice(1), 10).verdict).toBe("incomplete");
    const duplicated = pairs(10, 9);
    duplicated[19] = duplicated[1]!;
    expect(compare(duplicated, 10).verdict).toBe("incomplete");
    const failed = pairs(10, 9);
    failed[19] = run({ task: "H9", variant: "candidate", completed: false });
    expect(compare(failed, 10).verdict).toBe("regression");
    const useless = pairs(10, 9);
    useless[19] = run({ task: "H9", variant: "candidate", nestedSucceeded: 0 });
    expect(compare(useless, 10).verdict).toBe("target-not-met");
  });
  it("does not invent relative lift from a zero baseline", () => {
    expect(compare(pairs(4, 0), 4)).toMatchObject({
      relativeIncrease: null,
      absoluteIncrease: 1,
      targetMet: false,
    });
  });
  it("keeps negative controls out of the adoption rate but inside correctness checks", () => {
    const records = [
      ...pairs(10, 9),
      run({ task: "control", eligible: false }),
      run({ task: "control", eligible: false, variant: "candidate", correct: false }),
    ];
    expect(compare(records, 11)).toMatchObject({
      verdict: "regression",
      candidate: { eligibleSessions: 10, controlAdoptions: 1 },
    });
  });
  it("grades semantic JSON and rejects incorrect or unparseable answers", () => {
    const task = tasks.find((item) => item.id === "H1")!;
    expect(checkAnswer('```json\n{"US":2000,"EU":1200}\n```', task)).toBe(true);
    expect(checkAnswer('{"US":2000,"EU":1201}', task)).toBe(false);
    expect(checkAnswer("done", task)).toBe(false);
  });
  it("preallocates 48 attempts, paired order, and a disjoint confirmation split", () => {
    const plan = schedule();
    expect(plan).toHaveLength(48);
    expect(plan.slice(0, 8).every((item) => item.task.split === "development")).toBe(true);
    expect(plan.slice(8).every((item) => item.task.split === "held-out")).toBe(true);
    for (let index = 0; index < plan.length; index += 2) {
      expect(plan[index]!.task.id).toBe(plan[index + 1]!.task.id);
      expect(plan[index]!.variant).not.toBe(plan[index + 1]!.variant);
    }
    for (const variant of ["baseline", "candidate"]) {
      expect(
        plan.filter(
          (item) =>
            item.task.split === "held-out" && item.task.eligible && item.variant === variant,
        ),
      ).toHaveLength(16);
    }
  });
});
