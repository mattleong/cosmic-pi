// Test/benchmark boundary intentionally reports native timing.
import { performance } from "node:perf_hooks";
import { Text } from "@earendil-works/pi-tui";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { synchronousNow as previewNow } from "../src/boundary/clock";
import { createSimpleDiff } from "../src/diff/structured";
import { DeferredPreview } from "../src/preview/deferred";
import {
  clearCodePreviewSessionCapability,
  installCodePreviewSessionCapability,
  type CodePreviewSessionCapability,
} from "../src/application/capability";
import { previewScheduleEffect } from "../src/application/scheduler";
import { resolvePreviewLanguage } from "../src/syntax/language";
import {
  benchLog,
  benchTheme,
  printBenchHeader,
  printLayerSummary,
  runBench,
  timeOnce,
} from "./helpers";

printBenchHeader("render boundaries");
const cases = [
  runBench("synchronous clock", "render", "native-boundary", () => {
    previewNow();
  }),
  runBench("small JSON language probe", "render", "pure-boundary", () => {
    resolvePreviewLanguage({ content: '{"name":"preview","values":[1,2,3]}' });
  }),
  runBench("invalid JSON language probe", "render", "pure-boundary", () => {
    resolvePreviewLanguage({ content: '{"name":}' });
  }),
];
printLayerSummary(cases);

const clock = cases[0];
const json = cases[1];
if (!clock || clock.p95Ms > 0.002)
  throw new Error(`Synchronous clock p95 exceeded 0.002ms: ${clock?.p95Ms ?? "missing"}`);
if (!json || json.p95Ms > 0.01)
  throw new Error(`JSON language probe p95 exceeded 0.01ms: ${json?.p95Ms ?? "missing"}`);

const before = Array.from({ length: 250 }, (_, index) => `before ${index}`).join("\n");
const after = Array.from({ length: 250 }, (_, index) => `after ${index}`).join("\n");
const sampleMedian = (samples: readonly number[]): number => {
  const sorted = samples.toSorted((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};
const measureDiff = () => timeOnce(() => createSimpleDiff(before, after));
for (let warmup = 0; warmup < 3; warmup++) measureDiff();
const cpuSamplesMs = Array.from({ length: 9 }, measureDiff);
const cpuBlockMs = sampleMedian(cpuSamplesMs);
// Checked baseline from the documented five-run pre-gate sample on this repository/hardware.
const committedBaselineMedianMs = 6.329;
const regressionLimitMs = committedBaselineMedianMs * 1.1;
if (cpuBlockMs > regressionLimitMs)
  throw new Error(
    `Representative deferred diff median regressed beyond 10%: ${cpuBlockMs.toFixed(3)}ms > ${regressionLimitMs.toFixed(3)}ms`,
  );
if (cpuBlockMs > 50)
  throw new Error(`Representative deferred diff blocked for ${cpuBlockMs.toFixed(3)}ms`);

// SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
const capability = {
  token: 1,
  run: <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect),
  defer: (task: () => void) => {
    const fiber = Effect.runFork(Effect.yieldNow.pipe(Effect.andThen(Effect.sync(task))));
    return () => fiber.interruptUnsafe();
  },
  schedule: (interval: number, task: () => void) => {
    const fiber = Effect.runFork(previewScheduleEffect(interval, task));
    return () => fiber.interruptUnsafe();
  },
} as CodePreviewSessionCapability;
installCodePreviewSessionCapability(capability);
const cancellationSamplesMs: number[] = [];
let computed = false;
const sampleCancellation = Effect.gen(function* () {
  const cancellationStart = performance.now();
  const preview = new DeferredPreview(
    "loading",
    benchTheme(),
    () => {
      computed = true;
      return new Text("unexpected", 0, 0);
    },
    () => undefined,
  );
  preview.cancel();
  // Samples are intentionally sequential so each latency observes one event-loop turn.
  yield* Effect.sleep(Duration.zero);
  cancellationSamplesMs.push(performance.now() - cancellationStart);
});
await Effect.runPromise(
  Effect.forEach(Array.from({ length: 9 }), () => sampleCancellation, { discard: true }),
);
const cancellationLatencyMs = sampleMedian(cancellationSamplesMs);
clearCodePreviewSessionCapability();
if (computed) throw new Error("Cancelled deferred preview still computed.");
if (cancellationLatencyMs > 100)
  throw new Error(`Deferred cancellation latency exceeded 100ms: ${cancellationLatencyMs}`);
benchLog(
  `deferred method=3-warmup+9-sample-median baselineMs=${committedBaselineMedianMs.toFixed(3)} regressionLimitMs=${regressionLimitMs.toFixed(3)} cpuSamplesMs=${cpuSamplesMs.map((sample) => sample.toFixed(3)).join(",")} cpuMedianMs=${cpuBlockMs.toFixed(3)} cancellationSamplesMs=${cancellationSamplesMs.map((sample) => sample.toFixed(3)).join(",")} cancellationMedianMs=${cancellationLatencyMs.toFixed(3)} worker=not-justified`,
);
