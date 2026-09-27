/**
 * Retained-output publication boundary for the `code_mode` host Promise continuation.
 *
 * Pi delivers the settled result through a Promise, and cancellation can arrive between any two
 * awaits. The continuation therefore makes its final cancellation and currency check and publishes
 * the prepared artifact in the same synchronous turn. This runner accepts only the results
 * service's own commit: one total, requirement-free `Ref` transition with no services, clock,
 * spans or async work. Any failure publishes nothing.
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { PreparedResult } from "../results/model.ts";

export const commitPreparedResult = (prepared: PreparedResult): string | undefined => {
  const exit = Effect.runSyncExit(prepared.commit);
  return Exit.isSuccess(exit) ? exit.value : undefined;
};
