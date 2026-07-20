// Benchmark reporting and high-resolution timing are explicit non-application boundaries.
// @effect-diagnostics effect/globalConsole:off
// @effect-diagnostics effect/nodeBuiltinImport:off
import { performance } from "node:perf_hooks";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type { AdvisorCheckpointRequest, AdvisorRuntimeDriver } from "../src/advisor-runtime.ts";
import { advisorPlatformLayer, type AdvisorEffectExecutor } from "../src/boundary/executor.ts";
import { AdvisorReviewQueue } from "../src/review-queue.ts";

const managed = ManagedRuntime.make(advisorPlatformLayer);
const executor: AdvisorEffectExecutor = {
  run: (effect, signal) => managed.runPromise(effect, signal ? { signal } : undefined),
  fork: (effect) => managed.runFork(effect),
  now: () => performance.now(),
};
const driver: AdvisorRuntimeDriver = {
  activeToolNames: [],
  start: () => Promise.resolve(),
  checkpoint: (request: AdvisorCheckpointRequest) =>
    Promise.resolve({
      checkpointId: request.checkpointId,
      processedThrough: request.processedThrough,
      stateSummary: "",
      verdict: "pass" as const,
      summary: "pass",
      findings: [],
    }),
  steer: () => Promise.resolve(false),
  reprime: () => Promise.resolve(),
  abort: () => Promise.resolve(),
  dispose: () => Promise.resolve(),
};
const queue = new AdvisorReviewQueue(driver, {}, executor);

const ingestionStarted = performance.now();
for (let index = 0; index < 100_000; index += 1) {
  queue.ingest(1, { type: "assistant_text_delta", text: `token-${index};` });
}
const ingestionMs = performance.now() - ingestionStarted;

const checkpointStarted = performance.now();
for (let index = 0; index < 500; index += 1) {
  queue.ingest(index + 2, { type: "turn_complete", status: "stop" });
  await queue.checkpoint({
    checkpointId: `bench-${index}`,
    focus: "observation",
    parentTurnId: index + 2,
  });
}
const checkpointMs = performance.now() - checkpointStarted;
await queue.dispose();
await managed.dispose();

console.log(
  JSON.stringify(
    {
      ingestion: {
        operations: 100_000,
        totalMs: Number(ingestionMs.toFixed(3)),
        microsecondsPerOperation: Number(((ingestionMs * 1_000) / 100_000).toFixed(3)),
      },
      checkpoints: {
        operations: 500,
        totalMs: Number(checkpointMs.toFixed(3)),
        millisecondsPerOperation: Number((checkpointMs / 500).toFixed(3)),
      },
    },
    null,
    2,
  ),
);
