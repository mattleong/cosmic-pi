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
}

/** The sole adapter for Pi's Promise-returning command UI. */
export class PiCommandAdapter extends Context.Service<PiCommandAdapter, PiCommandAdapterShape>()(
  "pi-advisor/boundary/host-commands/PiCommandAdapter",
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
    }),
  );
}
