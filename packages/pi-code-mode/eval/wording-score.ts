import { compare, summarize, type RunRecord } from "./score.ts";
import { wordingTasks } from "./wording-tasks.ts";
import type { EvalTask } from "./tasks.ts";

/** Frozen before inference. Extra invocations or adoption are not success metrics. */
export const wordingGates = {
  totalTurnReduction: 0.1,
  taskBalancedTurnReduction: 0.1,
  maximumToolByteIncrease: 0.1,
  maximumTotalTokenIncrease: 0.1,
  maximumOutputTokenIncrease: 0.25,
  maximumOuterCallIncrease: 0,
  maximumControlTurnIncrease: 0,
  maximumMedianLatencyIncrease: 0.25,
} as const;

const key = (run: RunRecord) => `${run.task}:${run.repetition}`;
const totalTokens = (
  run: Pick<RunRecord, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
) => run.inputTokens + run.outputTokens + run.cacheReadTokens + run.cacheWriteTokens;
const mean = (values: readonly number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const within = (after: number, before: number, allowance: number) =>
  after <= before * (1 + allowance);
const valid = (run: RunRecord) =>
  run.correct &&
  run.completed &&
  run.boundaryViolations === 0 &&
  run.codeModeErrors === 0 &&
  run.nestedErrors === 0 &&
  run.directToolErrors === 0 &&
  run.codeModeTruncations === 0 &&
  run.nativeTruncations === 0 &&
  (run.nestedSucceeded > 0 || (run.directToolResultBytes ?? 0) > 0);
const workWithinBudget = (
  before: ReturnType<typeof summarize>,
  after: ReturnType<typeof summarize>,
) =>
  within(after.outerCalls, before.outerCalls, wordingGates.maximumOuterCallIncrease) &&
  within(after.toolResultBytes, before.toolResultBytes, wordingGates.maximumToolByteIncrease) &&
  within(totalTokens(after), totalTokens(before), wordingGates.maximumTotalTokenIncrease) &&
  within(after.outputTokens, before.outputTokens, wordingGates.maximumOutputTokenIncrease) &&
  before.medianElapsedMs !== null &&
  after.medianElapsedMs !== null &&
  within(after.medianElapsedMs, before.medianElapsedMs, wordingGates.maximumMedianLatencyIncrease);

export function compareWording(runs: readonly RunRecord[], expectedPairs: number) {
  const paired = compare(runs, expectedPairs);
  const repetitions = expectedPairs / wordingTasks.length;
  const expected = new Map<string, EvalTask>(
    repetitions === 2 || repetitions === 4
      ? wordingTasks.flatMap((task) =>
          Array.from(
            { length: repetitions },
            (_, repetition) => [`${task.id}:${repetition}`, task] as const,
          ),
        )
      : [],
  );
  const complete =
    paired.complete &&
    expected.size === expectedPairs &&
    runs.every((run) => {
      const task = expected.get(key(run));
      return task !== undefined && task.eligible === run.eligible && task.split === run.split;
    });
  const baselineRuns = runs.filter((run) => run.variant === "baseline");
  const candidateRuns = runs.filter((run) => run.variant === "candidate");
  const baselineByKey = new Map(baselineRuns.map((run) => [key(run), run]));
  const eligibleBefore = baselineRuns.filter((run) => run.eligible);
  const eligibleAfter = candidateRuns.filter((run) => run.eligible);
  const baseline = summarize(eligibleBefore);
  const candidate = summarize(eligibleAfter);
  const perPair = eligibleAfter.map((run) => {
    const before = baselineByKey.get(key(run));
    return {
      task: run.task,
      repetition: run.repetition,
      baselineTurns: before?.turns ?? null,
      candidateTurns: run.turns,
      savedTurns: before ? before.turns - run.turns : null,
      reduction: before && before.turns > 0 ? 1 - run.turns / before.turns : null,
    };
  });
  const perTask = wordingTasks
    .filter((task) => task.eligible)
    .map((task) => {
      const pairs = perPair.filter((pair) => pair.task === task.id);
      const reductions = pairs.flatMap((pair) => (pair.reduction === null ? [] : [pair.reduction]));
      return {
        task: task.id,
        reduction: reductions.length === repetitions ? mean(reductions) : null,
      };
    });
  const reductions = perTask.flatMap((task) => (task.reduction === null ? [] : [task.reduction]));
  const taskBalancedTurnReduction = reductions.length === perTask.length ? mean(reductions) : null;
  const totalTurnReduction =
    baseline.modelTurns > 0 ? 1 - candidate.modelTurns / baseline.modelTurns : null;
  const targetMet =
    totalTurnReduction !== null &&
    taskBalancedTurnReduction !== null &&
    totalTurnReduction + Number.EPSILON >= wordingGates.totalTurnReduction &&
    taskBalancedTurnReduction + Number.EPSILON >= wordingGates.taskBalancedTurnReduction;
  const controls = {
    baseline: summarize(baselineRuns.filter((run) => !run.eligible)),
    candidate: summarize(candidateRuns.filter((run) => !run.eligible)),
  };
  const baselineValid = baselineRuns.length > 0 && baselineRuns.every(valid);
  const candidateValid = candidateRuns.length > 0 && candidateRuns.every(valid);
  const noCompensatingWork = workWithinBudget(baseline, candidate);
  const noControlRegression =
    workWithinBudget(controls.baseline, controls.candidate) &&
    within(
      controls.candidate.modelTurns,
      controls.baseline.modelTurns,
      wordingGates.maximumControlTurnIncrease,
    );
  return {
    verdict: !complete
      ? "incomplete"
      : !candidateValid
        ? "regression"
        : !baselineValid
          ? "invalid-baseline"
          : targetMet && noCompensatingWork && noControlRegression
            ? "pilot-threshold-met"
            : "target-not-met",
    complete,
    baselineValid,
    candidateValid,
    targetMet,
    noCompensatingWork,
    noControlRegression,
    totalTurnReduction,
    taskBalancedTurnReduction,
    perTask,
    perPair,
    baseline,
    candidate,
    controls,
    allRuns: { baseline: paired.baseline, candidate: paired.candidate },
    baselineAtTurnFloor:
      eligibleBefore.length > 0 && eligibleBefore.every((run) => run.turns === 2),
    totalTokenRatio:
      totalTokens(baseline) > 0 ? totalTokens(candidate) / totalTokens(baseline) : null,
    estimatedCostRatio:
      baseline.estimatedCost > 0 ? candidate.estimatedCost / baseline.estimatedCost : null,
    note: "Small paired pilot, not statistical proof. Turns count finalized assistant messages, not proven missed batching opportunities. Two turns is the one-tool-round plus final-answer floor for these fixtures. All attempts and recovery work remain included.",
  };
}
