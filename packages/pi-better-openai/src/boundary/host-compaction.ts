import {
  compact,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class NativeCompactionError extends Schema.TaggedError<NativeCompactionError>()(
  "NativeCompactionError",
  { message: Schema.String },
) {}

/** Pi's registry owns provider authentication and runtime selection. */
export const compactWithPi = Effect.fn("BetterOpenAI.compactWithPi")(
  (
    ctx: ExtensionContext,
    event: SessionBeforeCompactEvent,
    preparation: SessionBeforeCompactEvent["preparation"],
  ) =>
    Effect.tryPromise({
      try: (signal) => {
        if (!ctx.model || event.signal.aborted || signal.aborted)
          return Promise.reject(new Error("Compaction unavailable."));
        return compact(
          preparation,
          ctx.model,
          undefined,
          undefined,
          event.customInstructions,
          signal,
          ctx.thinkingLevel,
          (model, context, options) => ctx.modelRegistry.streamSimple(model, context, options),
          undefined,
          undefined,
          undefined,
          ctx.sessionManager.getSessionId(),
        );
      },
      catch: () =>
        new NativeCompactionError({ message: "Unable to compact the restored Pi conversation." }),
    }),
);
