import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class HostBootstrapError extends Schema.TaggedError<HostBootstrapError>()("HostBootstrapError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

/**
 * Lifts a best-effort Promise host prerequisite into an interruptible startup workflow. The
 * loader receives an owned cancellation signal. A foreign Promise that ignores it is detached on
 * interruption, and its late settlement cannot delay session replacement.
 */
export const bestEffortHostBootstrap = <Value>(
  operation: string,
  load: (signal: AbortSignal) => PromiseLike<Value>,
): Effect.Effect<void> =>
  Effect.callback<void, HostBootstrapError>((resume) => {
    const controller = new AbortController();
    let active = true;
    void Promise.resolve()
      .then(() => load(controller.signal))
      .then(
        () => {
          if (active) resume(Effect.void);
        },
        () => {
          if (active)
            resume(
              Effect.fail(
                new HostBootstrapError({
                  operation,
                  message: "A best-effort host startup prerequisite failed.",
                }),
              ),
            );
        },
      );
    return Effect.sync(() => {
      active = false;
      controller.abort();
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.logDebug(error.message).pipe(Effect.annotateLogs("operation", error.operation)),
    ),
  );
