import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class PiCommandError extends Schema.TaggedError<PiCommandError>()("PiCommandError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

/** Adapt one genuine Promise-returning Pi command API at the host boundary. */
export const fromHostCommandPromise = <A>(
  operation: string,
  invoke: () => PromiseLike<A>,
): Effect.Effect<A, PiCommandError> =>
  Effect.tryPromise({
    try: invoke,
    catch: () =>
      new PiCommandError({
        operation,
        message: "Advisor command failed.",
      }),
  });

export const selectAtHostCommandBoundary = (
  ctx: Pick<ExtensionCommandContext, "ui">,
  title: string,
  choices: readonly string[],
): Effect.Effect<string | undefined, PiCommandError> =>
  fromHostCommandPromise("selection", () => ctx.ui.select(title, [...choices]));
