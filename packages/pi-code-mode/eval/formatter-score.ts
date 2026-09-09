import { compare, summarize, type RunRecord } from "./score.ts";
import { formatterFirstArm, formatterTasks } from "./formatter-tasks.ts";
import type { EvalTask } from "./tasks.ts";

/** Frozen before inference. Byte savings alone do not establish end-to-end token savings. */
export const formatterGates = {
  tokenReduction: 0.02,
  byteReduction: 0.1,
  minimumExposedFraction: 0.5,
  maximumOutputTokenIncrease: 0.1,
  maximumLatencyIncrease: 0.25,
  maximumControlTokenIncrease: 0.1,
  maximumControlByteIncrease: 0.1,
} as const;
const key = (run: RunRecord) => `${run.task}:${run.repetition}`;
const totalTokens = (
  run: Pick<RunRecord, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
) => run.inputTokens + run.outputTokens + run.cacheReadTokens + run.cacheWriteTokens;
const mean = (values: readonly number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const reduction = (before: number, after: number) => (before > 0 ? 1 - after / before : null);
const met = (value: number | null, threshold: number) =>
  value !== null && value + Number.EPSILON >= threshold;
const valid = (run: RunRecord) =>
  run.correct &&
  run.completed &&
  run.boundaryViolations === 0 &&
  run.codeModeErrors === 0 &&
  run.nestedErrors === 0 &&
  run.directToolErrors === 0 &&
  run.codeModeTruncations === 0 &&
  run.nativeTruncations === 0 &&
  run.formatter?.clampedCalls === 0 &&
  run.formatter.calls === run.codeModeCalls &&
  (run.nestedSucceeded > 0 || (run.directToolResultBytes ?? 0) > 0);
const exposure = (runs: readonly RunRecord[]) => ({
  episodes: runs.filter((run) => (run.formatter?.changedCalls ?? 0) > 0).length,
  calls: runs.reduce((n, r) => n + (r.formatter?.calls ?? 0), 0),
  structuredCalls: runs.reduce((n, r) => n + (r.formatter?.structuredCalls ?? 0), 0),
  stringCalls: runs.reduce((n, r) => n + (r.formatter?.stringCalls ?? 0), 0),
  changedCalls: runs.reduce((n, r) => n + (r.formatter?.changedCalls ?? 0), 0),
  sameValuePrettyBytes: runs.reduce((n, r) => n + (r.formatter?.prettyBytes ?? 0), 0),
  sameValueCompactBytes: runs.reduce((n, r) => n + (r.formatter?.compactBytes ?? 0), 0),
  prettyFallbackCalls: runs.reduce((n, r) => n + (r.formatter?.prettyFallbackCalls ?? 0), 0),
});
const workGuard = (before: ReturnType<typeof summarize>, after: ReturnType<typeof summarize>) =>
  after.modelTurns <= before.modelTurns &&
  after.outerCalls <= before.outerCalls &&
  after.outputTokens <= before.outputTokens * (1 + formatterGates.maximumOutputTokenIncrease) &&
  before.medianElapsedMs !== null &&
  after.medianElapsedMs !== null &&
  after.medianElapsedMs <= before.medianElapsedMs * (1 + formatterGates.maximumLatencyIncrease);

export function compareFormatter(runs: readonly RunRecord[], expectedPairs: number) {
  const paired = compare(runs, expectedPairs);
  const repetitions = expectedPairs / formatterTasks.length;
  const expected = new Map<string, EvalTask>(
    repetitions === 2 || repetitions === 4
      ? formatterTasks.flatMap((task) =>
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
      return (
        task !== undefined &&
        task.eligible === run.eligible &&
        task.split === run.split &&
        run.formatter !== undefined
      );
    });
  const before = runs.filter((run) => run.variant === "baseline");
  const after = runs.filter((run) => run.variant === "candidate");
  const byKey = new Map(before.map((run) => [key(run), run]));
  const targetsBefore = before.filter((run) => run.eligible),
    targetsAfter = after.filter((run) => run.eligible);
  const baseline = summarize(targetsBefore),
    candidate = summarize(targetsAfter);
  const perPair = targetsAfter.map((run) => {
    const peer = byKey.get(key(run));
    return {
      task: run.task,
      repetition: run.repetition,
      baselineTokens: peer ? totalTokens(peer) : null,
      candidateTokens: totalTokens(run),
      baselineBytes: peer?.toolResultBytes ?? null,
      candidateBytes: run.toolResultBytes,
      tokenReduction: peer ? reduction(totalTokens(peer), totalTokens(run)) : null,
      byteReduction: peer ? reduction(peer.toolResultBytes, run.toolResultBytes) : null,
    };
  });
  const perTask = formatterTasks
    .filter((task) => task.eligible)
    .map((task) => {
      const pairs = perPair.filter((pair) => pair.task === task.id);
      const tokens = pairs.flatMap((pair) =>
        pair.tokenReduction === null ? [] : [pair.tokenReduction],
      );
      const bytes = pairs.flatMap((pair) =>
        pair.byteReduction === null ? [] : [pair.byteReduction],
      );
      return {
        task: task.id,
        tokenReduction: tokens.length === repetitions ? mean(tokens) : null,
        byteReduction: bytes.length === repetitions ? mean(bytes) : null,
      };
    });
  const taskTokens = perTask.flatMap((task) =>
    task.tokenReduction === null ? [] : [task.tokenReduction],
  );
  const taskBytes = perTask.flatMap((task) =>
    task.byteReduction === null ? [] : [task.byteReduction],
  );
  const taskBalancedTokenReduction = taskTokens.length === perTask.length ? mean(taskTokens) : null;
  const taskBalancedByteReduction = taskBytes.length === perTask.length ? mean(taskBytes) : null;
  const totalTokenReduction = reduction(totalTokens(baseline), totalTokens(candidate));
  const totalByteReduction = reduction(baseline.toolResultBytes, candidate.toolResultBytes);
  const tokenTargetMet =
    met(totalTokenReduction, formatterGates.tokenReduction) &&
    met(taskBalancedTokenReduction, formatterGates.tokenReduction);
  const byteTargetMet =
    met(totalByteReduction, formatterGates.byteReduction) &&
    met(taskBalancedByteReduction, formatterGates.byteReduction);
  const formatterExposure = {
    baseline: exposure(targetsBefore),
    candidate: exposure(targetsAfter),
  };
  const enoughExposure =
    targetsBefore.length > 0 &&
    targetsAfter.length > 0 &&
    formatterExposure.baseline.episodes >=
      targetsBefore.length * formatterGates.minimumExposedFraction &&
    formatterExposure.candidate.episodes >=
      targetsAfter.length * formatterGates.minimumExposedFraction;
  const baselineValid = before.length > 0 && before.every(valid),
    candidateValid = after.length > 0 && after.every(valid);
  const controls = {
    baseline: summarize(before.filter((run) => !run.eligible)),
    candidate: summarize(after.filter((run) => !run.eligible)),
  };
  const noCompensatingWork = workGuard(baseline, candidate);
  const noControlRegression =
    workGuard(controls.baseline, controls.candidate) &&
    totalTokens(controls.candidate) <=
      totalTokens(controls.baseline) * (1 + formatterGates.maximumControlTokenIncrease) &&
    controls.candidate.toolResultBytes <=
      controls.baseline.toolResultBytes * (1 + formatterGates.maximumControlByteIncrease);
  return {
    verdict: !complete
      ? "incomplete"
      : !candidateValid
        ? "regression"
        : !baselineValid
          ? "invalid-baseline"
          : !enoughExposure
            ? "insufficient-exposure"
            : !noCompensatingWork || !noControlRegression
              ? "work-guard-failed"
              : tokenTargetMet && byteTargetMet
                ? "pilot-token-benefit"
                : byteTargetMet
                  ? "bytes-only"
                  : "target-not-met",
    complete,
    baselineValid,
    candidateValid,
    enoughExposure,
    noCompensatingWork,
    noControlRegression,
    tokenTargetMet,
    byteTargetMet,
    totalTokenReduction,
    totalByteReduction,
    taskBalancedTokenReduction,
    taskBalancedByteReduction,
    baseline,
    candidate,
    controls,
    formatterExposure,
    perTask,
    perPair,
    allRuns: { baseline: paired.baseline, candidate: paired.candidate },
    cacheByOrder: (["baseline", "candidate"] as const).flatMap((variant) =>
      [true, false].map((first) => ({
        variant,
        firstInPair: first,
        ...summarize(
          runs.filter(
            (run) =>
              run.variant === variant &&
              (formatterFirstArm(run.task, run.repetition) === variant) === first,
          ),
        ),
      })),
    ),
    note: "Small paired read-only pilot, not statistical proof. All routes, failures, and string/bypass episodes remain included. Cache-sensitive cost estimates and latency are descriptive, not independent evidence of savings.",
  };
}
