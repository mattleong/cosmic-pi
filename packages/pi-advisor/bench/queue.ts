// Benchmark reporting and high-resolution timing are explicit non-application boundaries.
// @effect-diagnostics effect/globalConsole:off
// @effect-diagnostics effect/nodeBuiltinImport:off
import { performance } from "node:perf_hooks";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type {
  AdvisorCheckpointRequest,
  AdvisorRuntimeServiceShape,
} from "../src/advisor-runtime.ts";
import { AdvisorReviewQueueService, advisorReviewQueueServiceLayer } from "../src/review-queue.ts";

const runtime: AdvisorRuntimeServiceShape = {
  activeToolNames: () => [],
  start: () => Effect.void,
  checkpoint: (request: AdvisorCheckpointRequest) =>
    Effect.succeed({
      checkpointId: request.checkpointId,
      processedThrough: request.processedThrough,
      stateSummary: "",
      verdict: "pass" as const,
      summary: "pass",
      findings: [],
    }),
  steer: () => Effect.succeed(false),
  reprime: () => Effect.void,
  abort: () => Effect.void,
  dispose: () => Effect.void,
};
const managed = ManagedRuntime.make(advisorReviewQueueServiceLayer);
const service = await managed.runPromise(AdvisorReviewQueueService);
const queue = await managed.runPromise(service.make(runtime));

const ingestionStarted = performance.now();
for (let index = 0; index < 100_000; index += 1) {
  queue.ingest(1, { type: "assistant_text_delta", text: `token-${index};` });
}
const ingestionMs = performance.now() - ingestionStarted;

const checkpointStarted = performance.now();
for (let index = 0; index < 500; index += 1) {
  queue.ingest(index + 2, { type: "turn_complete", status: "stop" });
  await managed.runPromise(
    queue.checkpointEffect({
      checkpointId: `bench-${index}`,
      focus: "observation",
      parentTurnId: index + 2,
    }),
  );
}
const checkpointMs = performance.now() - checkpointStarted;
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
