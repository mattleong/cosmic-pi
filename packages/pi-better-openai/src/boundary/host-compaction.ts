import type { RetryPolicy } from "@earendil-works/pi-ai";
import {
  compact,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { invokeHostCallback } from "pi-cosmic-core";

export class NativeCompactionError extends Schema.TaggedError<NativeCompactionError>()(
  "NativeCompactionError",
  { message: Schema.String },
) {}

/** The session's effective retry settings with Pi's defaults, as Pi passes them to its own compaction. */
export const piRetryPolicy = (pi: Pick<ExtensionAPI, "getSettings">) =>
  invokeHostCallback<RetryPolicy | undefined>(
    () => SettingsManager.inMemory(pi.getSettings()).getRetrySettings(),
    undefined,
  );

export const compactWithPi = Effect.fn("BetterOpenAI.compactWithPi")(
  (
    ctx: ExtensionContext,
    event: SessionBeforeCompactEvent,
    preparation: SessionBeforeCompactEvent["preparation"],
    retry: RetryPolicy | undefined,
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
          retry,
          undefined,
          ctx.sessionManager.getSessionId(),
        );
      },
      catch: () =>
        new NativeCompactionError({ message: "Unable to compact the restored Pi conversation." }),
    }),
);
