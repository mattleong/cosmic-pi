import * as Effect from "effect/Effect";
import type { McpBoundaryError } from "../../../client/errors.ts";

/** Bound one native SDK cleanup Promise. Only the deadline's wait is interruptible. */
export const boundedSdkCleanup = <A>(
  run: (signal: AbortSignal) => PromiseLike<A>,
  timeoutMs: number,
  failure: McpBoundaryError,
  timedOut = failure,
): Effect.Effect<A, McpBoundaryError> =>
  Effect.tryPromise({ try: run, catch: () => failure }).pipe(
    Effect.interruptible,
    Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.fail(timedOut) }),
  );
