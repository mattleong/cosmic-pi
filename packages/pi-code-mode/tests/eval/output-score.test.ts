import { describe, expect, it } from "vitest";
import { compareOutput } from "../../eval/output-score.ts";
import { checkAnswer, type RunRecord } from "../../eval/score.ts";
import { messageMetrics } from "../../eval/host-session.ts";
import { schedule } from "../../eval/pilot.ts";
import { outputTasks } from "../../eval/output-tasks.ts";

const run = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  task: "OH1",
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
  nestedOutputBytes: 10000,
  toolResultBytes: 1000,
  codeModeToolResultBytes: 1000,
  directToolResultBytes: 0,
  outerCalls: 1,
  turns: 2,
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedCost: 0.1,
  elapsedMs: 1000,
  boundaryViolations: 0,
  codeModeTruncations: 0,
  nativeTruncations: 0,
  ...overrides,
});
const paired = (): RunRecord[] =>
  Array.from({ length: 4 }, (_, index) => [
    run({ task: `OH${index}` }),
    run({
      task: `OH${index}`,
      variant: "candidate",
      toolResultBytes: 800,
      codeModeToolResultBytes: 800,
    }),
  ]).flat();

describe("output comparison", () => {
  it("requires aggregate and task-balanced savings, not one oversized baseline", () => {
    expect(compareOutput(paired(), 4).verdict).toBe("pilot-threshold-met");
    expect(compareOutput(paired(), 4).totalReduction).toBeCloseTo(0.2);
    const outlier = paired().map((record) =>
      record.variant === "candidate"
        ? { ...record, toolResultBytes: 1000, codeModeToolResultBytes: 1000 }
        : record,
    );
    outlier[0] = run({ task: "OH0", toolResultBytes: 10000, codeModeToolResultBytes: 10000 });
    expect(compareOutput(outlier, 4)).toMatchObject({
      verdict: "target-not-met",
      medianTaskReduction: 0,
    });
  });
  it("does not reward absent metrics, broken partitions, zero denominators, or incomplete pairs", () => {
    expect(compareOutput(paired().slice(1), 4).verdict).toBe("incomplete");
    const records = paired();
    const missing = { ...run({ task: "OH0", variant: "candidate" }) };
    delete missing.codeModeToolResultBytes;
    records[1] = missing;
    expect(compareOutput(records, 4).verdict).toBe("incomplete");
    records[1] = run({ task: "OH0", variant: "candidate", directToolResultBytes: 1 });
    expect(compareOutput(records, 4).verdict).toBe("incomplete");
    const empty = paired().map((record) => ({
      ...record,
      toolResultBytes: 0,
      codeModeToolResultBytes: 0,
    }));
    expect(compareOutput(empty, 4)).toMatchObject({ targetMet: false, totalReduction: null });
  });
  it("refuses incorrect or truncated answers and reports invalid baseline comparisons", () => {
    const records = paired();
    records[0] = run({ task: "OH0", correct: false });
    expect(compareOutput(records, 4).verdict).toBe("invalid-baseline");
    records[0] = run({ task: "OH0" });
    records[1] = run({
      task: "OH0",
      variant: "candidate",
      correct: false,
      toolResultBytes: 1,
      codeModeToolResultBytes: 1,
    });
    expect(compareOutput(records, 4).verdict).toBe("regression");
    records[1] = run({ task: "OH0", variant: "candidate", codeModeTruncations: 1 });
    expect(compareOutput(records, 4).verdict).toBe("regression");
  });
  it("blocks shifting data to direct tools or replacing fewer bytes with extra model work", () => {
    const offload = paired().map((record) =>
      record.variant === "candidate"
        ? { ...record, directToolResultBytes: 800, codeModeToolResultBytes: 0 }
        : record,
    );
    expect(compareOutput(offload, 4)).toMatchObject({
      targetMet: true,
      noRouteOffload: false,
      verdict: "target-not-met",
    });
    const extraWork = paired().map((record) =>
      record.variant === "candidate" ? { ...record, outerCalls: 2 } : record,
    );
    expect(compareOutput(extraWork, 4)).toMatchObject({
      noCompensatingWork: false,
      verdict: "target-not-met",
    });
  });
  it("keeps full-result controls complete without asking them to shrink", () => {
    const controls = [
      run({
        task: "control",
        eligible: false,
        toolResultBytes: 9000,
        codeModeToolResultBytes: 9000,
      }),
      run({
        task: "control",
        eligible: false,
        variant: "candidate",
        toolResultBytes: 9000,
        codeModeToolResultBytes: 9000,
      }),
    ];
    expect(compareOutput([...paired(), ...controls], 5)).toMatchObject({
      verdict: "pilot-threshold-met",
      baseline: { toolResultBytes: 4000 },
    });
    const bloated = {
      ...controls[1]!,
      toolResultBytes: 9_000_000,
      codeModeToolResultBytes: 9_000_000,
      outerCalls: 1000,
      elapsedMs: 100_000,
    };
    expect(compareOutput([...paired(), controls[0]!, bloated], 5)).toMatchObject({
      targetMet: true,
      noControlRegression: false,
      verdict: "target-not-met",
    });
    controls[1] = { ...controls[1]!, correct: false };
    expect(compareOutput([...paired(), ...controls], 5).verdict).toBe("regression");
    const document = outputTasks.find((task) => task.id === "OH10")!;
    expect(checkAnswer(JSON.stringify(String(document.expected).slice(0, -1)), document)).toBe(
      false,
    );
    const audit = outputTasks.find((task) => task.id === "OH4")!;
    expect(checkAnswer('{"checkedActive":200,"findings":[]}', audit)).toBe(false);
  });
  it("uses a fresh balanced suite and never labels historical tasks as held-out", () => {
    const plan = schedule("output");
    expect(plan).toHaveLength(48);
    expect(plan.every((entry) => entry.task.id.startsWith("O"))).toBe(true);
    expect(plan.slice(0, 8).every((entry) => entry.task.split === "development")).toBe(true);
    expect(plan.slice(8).filter((entry) => entry.task.eligible)).toHaveLength(32);
    expect(plan.slice(8).filter((entry) => !entry.task.eligible)).toHaveLength(8);
  });
});

describe("model-visible byte accounting", () => {
  it("partitions UTF-8 bytes across routes including failures, retaining only bounded metadata", () => {
    const messages: Parameters<typeof messageMetrics>[0] = Array.from(
      { length: 9 },
      (_, index) => ({
        role: "toolResult",
        toolCallId: `call-${index}`,
        toolName: index % 2 ? "code_mode" : "read",
        content: [{ type: "text", text: "é".repeat(index + 1) }],
        details: {},
        isError: index === 7,
        timestamp: index,
      }),
    );
    const result = messageMetrics(messages);
    expect(result.toolResultBytes).toBe(90);
    expect(result.codeModeToolResultBytes).toBe(40);
    expect(result.directToolResultBytes).toBe(50);
    expect(result.codeModeErrors).toBe(1);
    expect(result.largestToolResults).toHaveLength(5);
    expect(result.largestToolResults[0]).toEqual({
      index: 8,
      tool: "read",
      bytes: 18,
      isError: false,
    });
    expect(JSON.stringify(result.largestToolResults)).not.toContain("é");
  });
});
