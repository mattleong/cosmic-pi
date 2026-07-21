import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class OpenAIHostUiError extends Schema.TaggedErrorClass<OpenAIHostUiError>()(
  "OpenAIHostUiError",
  { operation: Schema.String, message: Schema.String },
) {}

/** Isolates synchronous Pi UI callbacks from the Effect application error channel. */
export const tryHostUi = Effect.fn("OpenAIHostUi.try")(function* <A>(
  operation: string,
  callback: () => A,
) {
  return yield* Effect.try({
    try: callback,
    catch: () =>
      new OpenAIHostUiError({
        operation,
        message: "Unable to update Better OpenAI UI.",
      }),
  });
});

/** Best-effort adapter for Pi callbacks that cannot enter the session runtime. */
export function safeHostUi(callback: () => unknown): void {
  try {
    callback();
  } catch {
    // Host UI failures never replace the application outcome being reported.
  }
}

/** Materializes Pi's dynamic cancellation signal without allowing a host getter to defect. */
export function safeHostSignal(ctx: ExtensionContext): AbortSignal | undefined {
  try {
    return ctx.signal;
  } catch {
    return undefined;
  }
}
