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

export class NativeCompactionError extends Schema.TaggedError<
  NativeCompactionError,
  { readonly brand: unique symbol }
>()("NativeCompactionError", { message: Schema.String }) {}

/** The session's effective retry settings with Pi's defaults, as Pi passes them to its own compaction. */
export const piRetryPolicy = (pi: Pick<ExtensionAPI, "getSettings">) =>
  invokeHostCallback<RetryPolicy | undefined>(
    () => SettingsManager.inMemory(pi.getSettings()).getRetrySettings(),
    undefined,
  );

const compactionUnavailable = () =>
  NativeCompactionError.make({ message: "Unable to compact the restored Pi conversation." });

export const compactWithPi = Effect.fn("BetterOpenAI.compactWithPi")(function* (
  ctx: ExtensionContext,
  event: SessionBeforeCompactEvent,
  preparation: SessionBeforeCompactEvent["preparation"],
  retry: RetryPolicy | undefined,
) {
  // Preconditions fail as typed errors before any host Promise starts.
  const compactionModel = yield* Effect.try({
    try: () => (event.signal.aborted ? undefined : ctx.model),
    catch: compactionUnavailable,
  });
  if (!compactionModel) return yield* compactionUnavailable();
  return yield* Effect.tryPromise({
    try: (signal) =>
      compact(
        preparation,
        compactionModel,
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
      ),
    catch: compactionUnavailable,
  });
});
