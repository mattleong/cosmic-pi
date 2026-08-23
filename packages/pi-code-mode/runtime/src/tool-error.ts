import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Safe operational refusal from a standard tool pack, reported as `ToolFailure`. */
export class ToolError extends Schema.TaggedError<ToolError>()("ToolError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** Creates a tool refusal whose message is safe to include in an execution diagnostic. */
export const toolError = (message: string, cause?: unknown): ToolError =>
  cause === undefined ? new ToolError({ message }) : new ToolError({ message, cause });

/**
 * Normalizes an arbitrary host effect onto the closed `ToolError` channel: explicit
 * `ToolError` refusals pass through, interruption keeps propagating as interruption, and
 * every other failure or defect collapses into a generic (message-safe) `ToolError`.
 */
export const runHost = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ToolError, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
      const error = Cause.squash(cause);
      return Effect.fail(
        error instanceof ToolError ? error : toolError("Tool execution failed", error),
      );
    }),
  );
