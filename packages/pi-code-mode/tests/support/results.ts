import * as Effect from "effect/Effect";
import type { ResultArtifact } from "../../src/results/model.ts";
import type { ResultsContract } from "../../src/results/service.ts";
import type { ExecutionReceipts } from "../../src/tools/execution-receipts.ts";
import { callEntryDetails } from "../../src/tools/format.ts";
import { makeResultResponse } from "../../src/tools/result-response.ts";

export const EMPTY_RECEIPTS: ExecutionReceipts = {
  total: 0,
  completed: 0,
  unknown: 0,
  notSent: 0,
  omitted: 0,
  calls: [],
};

/** A results store that keeps each put under `id`, or refuses every put when `id` is absent. */
export const recordingResults = (id?: string) => {
  let stored: ResultArtifact | undefined;
  const results: ResultsContract = {
    put: (text, outcome, kind = "output") =>
      Effect.sync(() => {
        if (id === undefined) return undefined;
        stored = { id, text, outcome, kind, cost: 0 };
        return id;
      }),
    get: () => Effect.succeed(stored),
  };
  return { results, stored: () => stored };
};

type ResultResponseInput = Parameters<typeof makeResultResponse>[0];

/** A response for a current, unaborted execution with no calls unless the test overrides it. */
export const resultResponseFixture = (
  input: Pick<ResultResponseInput, "results" | "capture"> & Partial<ResultResponseInput>,
) =>
  makeResultResponse({
    maxBytes: 3_000,
    run: Effect.runPromise,
    current: () => true,
    aborted: () => false,
    settle: () => callEntryDetails([]),
    receipts: () => EMPTY_RECEIPTS,
    nestedOutputLost: () => false,
    retain: () => undefined,
    ...input,
  });
