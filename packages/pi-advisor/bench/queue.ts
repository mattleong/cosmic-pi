// Benchmark reporting and high-resolution timing are explicit non-application boundaries.
import { performance } from "node:perf_hooks";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type {
  AdvisorCheckpointRequest,
  AdvisorRuntimeServiceContract,
} from "../src/runtime/runtime.ts";
import { makeAdvisorReviewQueue } from "../src/queue/review-queue.ts";

const runtime: AdvisorRuntimeServiceContract = {
  activeToolNames: () => [],
  start: () => Effect.void,
  checkpoint: (request: AdvisorCheckpointRequest) =>
    Effect.succeed({
      checkpointId: request.checkpointId,
      processedThrough: request.processedThrough,
      stateSummary: "",
      verdict: "pass" as const,
      summary: "pass",
      suggestions: [],
      findings: [],
    }),
  steer: () => Effect.succeed(false),
  reprime: () => Effect.void,
  abort: () => Effect.void,
  dispose: () => Effect.void,
};

const managed = ManagedRuntime.make(Layer.empty);
const median = (samples: readonly number[]): number => {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};
const measure = (ingestionOperations: number, checkpointOperations: number, sample: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const queue = yield* makeAdvisorReviewQueue(runtime);
      const ingestionStarted = performance.now();
      for (let index = 0; index < ingestionOperations; index += 1) {
        queue.ingest(1, { type: "assistant_text_delta", text: `token-${index};` });
      }
      const ingestionMicrosecondsPerOperation =
        ((performance.now() - ingestionStarted) * 1_000) / ingestionOperations;

      const checkpointStarted = performance.now();
      for (let index = 0; index < checkpointOperations; index += 1) {
        queue.ingest(index + 2, { type: "turn_complete", status: "stop" });
        yield* queue.checkpointEffect({
          checkpointId: `bench-${sample}-${index}`,
          focus: "observation",
        });
      }
      const checkpointMillisecondsPerOperation =
        (performance.now() - checkpointStarted) / checkpointOperations;
      yield* queue.disposeEffect();
      return { checkpointMillisecondsPerOperation, ingestionMicrosecondsPerOperation };
    }),
  );

for (let warmup = 0; warmup < 3; warmup += 1) {
  await managed.runPromise(measure(10_000, 50, -warmup - 1));
}
const ingestionSamples: number[] = [];
const checkpointSamples: number[] = [];
for (let sample = 0; sample < 7; sample += 1) {
  const measured = await managed.runPromise(measure(100_000, 500, sample));
  ingestionSamples.push(measured.ingestionMicrosecondsPerOperation);
  checkpointSamples.push(measured.checkpointMillisecondsPerOperation);
}
await managed.dispose();

const ingestionMedian = median(ingestionSamples);
const checkpointMedian = median(checkpointSamples);
// Checked pre-cutover medians from five runs on the reference development machine. These are a
// regression ratchet, not a portable hardware performance claim; see the architecture notes.
const committedBaseline = {
  ingestionMicrosecondsPerOperation: 8.65,
  checkpointMillisecondsPerOperation: 0.0475,
} as const;
const ingestionLimit = committedBaseline.ingestionMicrosecondsPerOperation * 1.1;
const checkpointLimit = committedBaseline.checkpointMillisecondsPerOperation * 1.1;
const ingestionPass = ingestionMedian <= ingestionLimit;
const checkpointPass = checkpointMedian <= checkpointLimit;
const violations = [
  ...(ingestionPass
    ? []
    : [
        `Advisor ingestion median regressed beyond 10%: ${ingestionMedian.toFixed(3)}us > ${ingestionLimit.toFixed(3)}us`,
      ]),
  ...(checkpointPass
    ? []
    : [
        `Advisor checkpoint median regressed beyond 10%: ${checkpointMedian.toFixed(3)}ms > ${checkpointLimit.toFixed(3)}ms`,
      ]),
];

process.stdout.write(
  `${JSON.stringify(
    {
      method: "3-warmup+7-sample-median",
      pass: violations.length === 0,
      violations,
      ingestion: {
        pass: ingestionPass,
        operationsPerSample: 100_000,
        samplesMicrosecondsPerOperation: ingestionSamples.map((value) => Number(value.toFixed(3))),
        medianMicrosecondsPerOperation: Number(ingestionMedian.toFixed(3)),
        committedBaselineMicrosecondsPerOperation:
          committedBaseline.ingestionMicrosecondsPerOperation,
        regressionLimitMicrosecondsPerOperation: Number(ingestionLimit.toFixed(3)),
      },
      checkpoints: {
        pass: checkpointPass,
        operationsPerSample: 500,
        samplesMillisecondsPerOperation: checkpointSamples.map((value) => Number(value.toFixed(3))),
        medianMillisecondsPerOperation: Number(checkpointMedian.toFixed(3)),
        committedBaselineMillisecondsPerOperation:
          committedBaseline.checkpointMillisecondsPerOperation,
        regressionLimitMillisecondsPerOperation: Number(checkpointLimit.toFixed(3)),
      },
    },
    null,
    2,
  )}\n`,
);
if (violations.length > 0) process.exitCode = 1;
