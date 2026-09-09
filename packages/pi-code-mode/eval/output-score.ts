import { compare, median, summarize, type RunRecord } from "./score.ts";

/** Frozen before model execution. Controls must stay complete, not become smaller. */
export const outputGates = {
  totalByteReduction: 0.15,
  medianTaskByteReduction: 0.1,
  maximumDirectByteIncreaseFraction: 0.1,
  maximumDirectByteIncreaseFloor: 1024,
  maximumOuterCallIncrease: 0.25,
  maximumOutputTokenIncrease: 0.25,
  maximumTotalTokenIncrease: 0.1,
  maximumMedianLatencyIncrease: 0.25,
  maximumControlToolByteIncrease: 0.25,
} as const;

const sum = (runs: readonly RunRecord[], select: (run: RunRecord) => number) =>
  runs.reduce((total, run) => total + select(run), 0);
const totalTokens = (
  run: Pick<RunRecord, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
) => run.inputTokens + run.outputTokens + run.cacheReadTokens + run.cacheWriteTokens;
const ratio = (candidate: number, baseline: number) => (baseline > 0 ? candidate / baseline : null);
const noExcess = (candidate: number, baseline: number, allowance: number) =>
  candidate <= baseline * (1 + allowance);

const withinWorkBudget = (
  baseline: ReturnType<typeof summarize>,
  candidate: ReturnType<typeof summarize>,
): boolean =>
  (baseline.sessions === 0 && candidate.sessions === 0) ||
  (noExcess(candidate.outerCalls, baseline.outerCalls, outputGates.maximumOuterCallIncrease) &&
    noExcess(
      candidate.outputTokens,
      baseline.outputTokens,
      outputGates.maximumOutputTokenIncrease,
    ) &&
    noExcess(
      totalTokens(candidate),
      totalTokens(baseline),
      outputGates.maximumTotalTokenIncrease,
    ) &&
    baseline.medianElapsedMs !== null &&
    candidate.medianElapsedMs !== null &&
    noExcess(
      candidate.medianElapsedMs,
      baseline.medianElapsedMs,
      outputGates.maximumMedianLatencyIncrease,
    ));

export function compareOutput(runs: readonly RunRecord[], expectedPairs: number) {
  const paired = compare(runs, expectedPairs);
  const baselineRuns = runs.filter((run) => run.variant === "baseline");
  const candidateRuns = runs.filter((run) => run.variant === "candidate");
  const baselineEligible = baselineRuns.filter((run) => run.eligible);
  const candidateEligible = candidateRuns.filter((run) => run.eligible);
  const baseline = summarize(baselineEligible);
  const candidate = summarize(candidateEligible);
  const routeMetricsPresent = runs.every(
    (run) =>
      run.codeModeToolResultBytes !== undefined &&
      run.directToolResultBytes !== undefined &&
      Number.isFinite(run.codeModeToolResultBytes) &&
      Number.isFinite(run.directToolResultBytes) &&
      run.codeModeToolResultBytes >= 0 &&
      run.directToolResultBytes >= 0 &&
      run.codeModeToolResultBytes + run.directToolResultBytes === run.toolResultBytes,
  );
  const complete = paired.complete && routeMetricsPresent && baselineEligible.length > 0;
  const taskIds = [...new Set(baselineEligible.map((run) => run.task))].sort();
  const perTask = taskIds.map((task) => {
    const before = sum(
      baselineEligible.filter((run) => run.task === task),
      (run) => run.toolResultBytes,
    );
    const after = sum(
      candidateEligible.filter((run) => run.task === task),
      (run) => run.toolResultBytes,
    );
    return {
      task,
      baselineBytes: before,
      candidateBytes: after,
      reduction: before > 0 ? 1 - after / before : null,
    };
  });
  const reductions = perTask.flatMap((task) => (task.reduction === null ? [] : [task.reduction]));
  const medianTaskReduction = reductions.length === perTask.length ? median(reductions) : null;
  const totalReduction =
    baseline.toolResultBytes > 0 ? 1 - candidate.toolResultBytes / baseline.toolResultBytes : null;
  const targetMet =
    totalReduction !== null &&
    medianTaskReduction !== null &&
    totalReduction + Number.EPSILON >= outputGates.totalByteReduction &&
    medianTaskReduction + Number.EPSILON >= outputGates.medianTaskByteReduction;
  const baselineDirectBytes = sum(baselineEligible, (run) => run.directToolResultBytes ?? 0);
  const candidateDirectBytes = sum(candidateEligible, (run) => run.directToolResultBytes ?? 0);
  const baselineValid = baselineRuns.every(
    (run) =>
      run.correct && run.completed && run.codeModeTruncations === 0 && run.nativeTruncations === 0,
  );
  const candidateValid = candidateRuns.every(
    (run) =>
      run.correct && run.completed && run.codeModeTruncations === 0 && run.nativeTruncations === 0,
  );
  const safe = runs.every((run) => run.boundaryViolations === 0 && run.completed);
  const noRouteOffload =
    candidate.usefulAdoptions >= baseline.usefulAdoptions &&
    candidateDirectBytes <=
      baselineDirectBytes +
        Math.max(
          outputGates.maximumDirectByteIncreaseFloor,
          baseline.toolResultBytes * outputGates.maximumDirectByteIncreaseFraction,
        );
  const noCompensatingWork = withinWorkBudget(baseline, candidate);
  const baselineControls = baselineRuns.filter((run) => !run.eligible);
  const candidateControls = candidateRuns.filter((run) => !run.eligible);
  const controls = {
    baseline: summarize(baselineControls),
    candidate: summarize(candidateControls),
  };
  const noControlRegression =
    withinWorkBudget(controls.baseline, controls.candidate) &&
    noExcess(
      controls.candidate.toolResultBytes,
      controls.baseline.toolResultBytes,
      outputGates.maximumControlToolByteIncrease,
    ) &&
    controls.candidate.usefulAdoptions >= controls.baseline.usefulAdoptions &&
    sum(candidateControls, (run) => run.directToolResultBytes ?? 0) <=
      sum(baselineControls, (run) => run.directToolResultBytes ?? 0) +
        Math.max(
          outputGates.maximumDirectByteIncreaseFloor,
          controls.baseline.toolResultBytes * outputGates.maximumDirectByteIncreaseFraction,
        );
  return {
    verdict: !complete
      ? "incomplete"
      : !safe || !candidateValid
        ? "regression"
        : !baselineValid
          ? "invalid-baseline"
          : targetMet && noRouteOffload && noCompensatingWork && noControlRegression
            ? "pilot-threshold-met"
            : "target-not-met",
    complete,
    targetMet,
    baselineValid,
    candidateValid,
    safe,
    noRouteOffload,
    noCompensatingWork,
    noControlRegression,
    totalReduction,
    medianTaskReduction,
    perTask,
    baseline,
    candidate,
    controls,
    allRuns: { baseline: paired.baseline, candidate: paired.candidate },
    routeBytes: {
      baselineDirect: baselineDirectBytes,
      candidateDirect: candidateDirectBytes,
      baselineCodeMode: sum(baselineEligible, (run) => run.codeModeToolResultBytes ?? 0),
      candidateCodeMode: sum(candidateEligible, (run) => run.codeModeToolResultBytes ?? 0),
    },
    totalTokenRatio: ratio(sum(candidateEligible, totalTokens), sum(baselineEligible, totalTokens)),
    estimatedCostRatio: ratio(candidate.estimatedCost, baseline.estimatedCost),
    note: "Fresh paired pilot, not statistical proof. Failed or truncated answers cannot establish output savings. Full-result controls are excluded only from the reduction objective.",
  };
}
