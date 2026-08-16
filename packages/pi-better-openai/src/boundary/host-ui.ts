import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { captureHostSignal, invokeHostCallback } from "pi-cosmic-core";

export class OpenAIHostUiError extends Schema.TaggedError<OpenAIHostUiError>()(
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

export const ignoreHostUi = <Result>(operation: string, callback: () => Result) =>
  tryHostUi(operation, callback).pipe(
    Effect.catchTag("OpenAIHostUiError", () => Effect.void),
    Effect.asVoid,
  );

/** Best-effort adapter for Pi callbacks that cannot enter the session runtime. */
export function safeHostUi<Result>(callback: () => Result): void {
  invokeHostCallback(callback, undefined);
}

/** Materializes Pi's dynamic cancellation signal without allowing a host getter to defect. */
export function safeHostSignal(ctx: ExtensionContext): AbortSignal | undefined {
  const captured = captureHostSignal(ctx);
  return captured._tag === "Captured" ? captured.signal : undefined;
}
