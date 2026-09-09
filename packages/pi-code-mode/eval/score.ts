import { gradeAnswer } from "./answer-check.ts";
import type { FormatterMeasurements } from "./formatter.ts";
import type { EvalTask } from "./tasks.ts";

export interface RunRecord {
  readonly task: string;
  readonly split: EvalTask["split"];
  readonly eligible: boolean;
  readonly variant: "baseline" | "candidate";
  readonly repetition: number;
  readonly correct: boolean;
  readonly answerMismatchPaths?: readonly string[];
  readonly formatter?: Readonly<FormatterMeasurements>;
  readonly completed: boolean;
  readonly codeModeCalls: number;
  readonly codeModeErrors: number;
  /** Present in wording-pilot records; older records cannot establish error-free direct work. */
  readonly directToolErrors?: number;
  readonly nestedCalls: number;
  readonly nestedSucceeded: number;
  readonly nestedErrors: number;
  readonly nestedOutputBytes: number;
  readonly toolResultBytes: number;
  /** Added by the output pilot. Historical adoption records lack route-level byte counts. */
  readonly codeModeToolResultBytes?: number;
  readonly directToolResultBytes?: number;
  readonly largestToolResults?: readonly {
    readonly index: number;
    readonly tool: string;
    readonly bytes: number;
    readonly isError: boolean;
  }[];
  readonly outerCalls: number;
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly estimatedCost: number;
  readonly elapsedMs: number;
  readonly boundaryViolations: number;
  readonly codeModeTruncations: number;
  readonly nativeTruncations: number;
}

export function checkAnswer(text: string, task: EvalTask): boolean {
  return gradeAnswer(text, task).correct;
}

export const adopted = (run: RunRecord): boolean => run.codeModeCalls > 0 && run.nestedCalls > 0;
export const usefulAdoption = (run: RunRecord): boolean =>
  adopted(run) &&
  run.correct &&
  run.completed &&
  run.nestedSucceeded > 0 &&
  run.codeModeErrors === 0;

export const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};

export function summarize(runs: readonly RunRecord[]) {
  const eligible = runs.filter((run) => run.eligible);
  const controls = runs.filter((run) => !run.eligible);
  const sum = (select: (run: RunRecord) => number) =>
    runs.reduce((total, run) => total + select(run), 0);
  return {
    sessions: runs.length,
    eligibleSessions: eligible.length,
    adopted: eligible.filter(adopted).length,
    usefulAdoptions: eligible.filter(usefulAdoption).length,
    adoptionRate: eligible.length ? eligible.filter(adopted).length / eligible.length : null,
    controlAdoptions: controls.filter(adopted).length,
    correct: runs.filter((run) => run.correct).length,
    completed: runs.filter((run) => run.completed).length,
    rawCodeModeCalls: sum((run) => run.codeModeCalls),
    nestedCalls: sum((run) => run.nestedCalls),
    nestedErrors: sum((run) => run.nestedErrors),
    codeModeErrors: sum((run) => run.codeModeErrors),
    directToolErrors: sum((run) => run.directToolErrors ?? 0),
    outerCalls: sum((run) => run.outerCalls),
    modelTurns: sum((run) => run.turns),
    toolResultBytes: sum((run) => run.toolResultBytes),
    nestedOutputBytes: sum((run) => run.nestedOutputBytes),
    inputTokens: sum((run) => run.inputTokens),
    outputTokens: sum((run) => run.outputTokens),
    cacheReadTokens: sum((run) => run.cacheReadTokens),
    cacheWriteTokens: sum((run) => run.cacheWriteTokens),
    estimatedCost: sum((run) => run.estimatedCost),
    medianElapsedMs: median(runs.map((run) => run.elapsedMs)),
    medianSuccessfulElapsedMs: median(
      runs.filter((run) => run.correct).map((run) => run.elapsedMs),
    ),
    boundaryViolations: sum((run) => run.boundaryViolations),
    codeModeTruncations: sum((run) => run.codeModeTruncations),
    nativeTruncations: sum((run) => run.nativeTruncations),
  };
}

/** No successful-run filtering in the adoption denominator; incomplete pilots never pass. */
export function compare(runs: readonly RunRecord[], expectedPairs: number) {
  const baselineRuns = runs.filter((run) => run.variant === "baseline");
  const candidateRuns = runs.filter((run) => run.variant === "candidate");
  const key = (run: RunRecord) => `${run.task}:${run.repetition}`;
  const baselineByKey = new Map(baselineRuns.map((run) => [key(run), run]));
  const candidateKeys = new Set(candidateRuns.map(key));
  const complete =
    baselineRuns.length === expectedPairs &&
    candidateRuns.length === expectedPairs &&
    baselineByKey.size === expectedPairs &&
    candidateKeys.size === expectedPairs &&
    candidateRuns.every((run) => {
      const peer = baselineByKey.get(key(run));
      return peer !== undefined && peer.eligible === run.eligible && peer.split === run.split;
    });
  const baseline = summarize(baselineRuns);
  const candidate = summarize(candidateRuns);
  const relativeIncrease =
    baseline.adoptionRate !== null && baseline.adoptionRate > 0 && candidate.adoptionRate !== null
      ? candidate.adoptionRate / baseline.adoptionRate - 1
      : null;
  const absoluteIncrease =
    baseline.adoptionRate !== null && candidate.adoptionRate !== null
      ? candidate.adoptionRate - baseline.adoptionRate
      : null;
  const regressions = candidateRuns
    .filter((run) => baselineByKey.get(key(run))?.correct && !run.correct)
    .map(key);
  const newAdoptions = candidateRuns.filter(
    (run) => adopted(run) && !adopted(baselineByKey.get(key(run)) ?? run),
  );
  const safetyPassed = runs.every((run) => run.boundaryViolations === 0 && run.completed);
  const correctnessPassed =
    candidateRuns.length > 0 &&
    candidateRuns.every((run) => run.correct) &&
    regressions.length === 0;
  const targetMet = relativeIncrease !== null && relativeIncrease + Number.EPSILON >= 0.1;
  const pass =
    complete &&
    safetyPassed &&
    correctnessPassed &&
    targetMet &&
    newAdoptions.every(usefulAdoption);
  return {
    verdict: !complete
      ? "incomplete"
      : !safetyPassed || !correctnessPassed
        ? "regression"
        : pass
          ? "pilot-threshold-met"
          : "target-not-met",
    baseline,
    candidate,
    relativeIncrease,
    absoluteIncrease,
    regressions,
    complete,
    targetMet,
    ceilingBlocked: baseline.adoptionRate !== null && baseline.adoptionRate > 1 / 1.1,
    note: "Small paired pilot, not statistical proof. Relative lift is undefined when baseline adoption is zero.",
    pairedAdoption: candidateRuns.map((run) => ({
      pair: key(run),
      eligible: run.eligible,
      baseline: baselineByKey.has(key(run)) ? adopted(baselineByKey.get(key(run))!) : null,
      candidate: adopted(run),
      correct: run.correct,
    })),
  };
}
