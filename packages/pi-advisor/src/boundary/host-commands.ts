import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class PiCommandError extends Schema.TaggedError<PiCommandError>()("PiCommandError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

/** Adapt one Promise-returning Pi command handler at the host boundary. */
export const fromHostCommandPromise = <A>(
  operation: () => Promise<A>,
): Effect.Effect<A, PiCommandError> =>
  Effect.tryPromise({
    try: operation,
    catch: () =>
      new PiCommandError({
        operation: "handler",
        message: "Advisor command failed.",
      }),
  });
