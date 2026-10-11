import * as Effect from "effect/Effect";

export const bestEffortHostBootstrap = <Value>(
  operation: string,
  load: (signal: AbortSignal) => PromiseLike<Value>,
): Effect.Effect<void> =>
  Effect.tryPromise((signal) => load(signal)).pipe(
    Effect.asVoid,
    Effect.catch(() =>
      Effect.logDebug("A best-effort host startup prerequisite failed.").pipe(
        Effect.annotateLogs("operation", operation),
      ),
    ),
  );
