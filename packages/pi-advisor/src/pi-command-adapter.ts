import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class PiCommandError extends Schema.TaggedErrorClass<PiCommandError>()("PiCommandError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface PiCommandAdapterShape {
  readonly fromPromise: <A>(operation: () => Promise<A>) => Effect.Effect<A, PiCommandError>;
  readonly notify: (
    ctx: ExtensionCommandContext,
    message: string,
    level: "info" | "warning" | "error",
  ) => Effect.Effect<void>;
  readonly select: (
    ctx: ExtensionCommandContext,
    title: string,
    options: readonly string[],
  ) => Effect.Effect<string | undefined, PiCommandError>;
}

/** The sole adapter for Pi's Promise-returning command UI. */
export class PiCommandAdapter extends Context.Service<PiCommandAdapter, PiCommandAdapterShape>()(
  "pi-advisor/pi-command-adapter/PiCommandAdapter",
) {
  static readonly layer = Layer.succeed(
    PiCommandAdapter,
    PiCommandAdapter.of({
      fromPromise: (operation) =>
        Effect.tryPromise({
          try: operation,
          catch: () =>
            new PiCommandError({
              operation: "handler",
              message: "Advisor command failed.",
            }),
        }),
      notify: (ctx, message, level) =>
        Effect.sync(() => {
          ctx.ui.notify(message, level);
        }).pipe(Effect.catchDefect(() => Effect.void)),
      select: (ctx, title, options) =>
        Effect.tryPromise({
          try: () => ctx.ui.select(title, [...options]),
          catch: () =>
            new PiCommandError({
              operation: "select",
              message: "Advisor command selection failed.",
            }),
        }),
    }),
  );
}
