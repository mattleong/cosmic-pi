import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class XaiHostUiError extends Schema.TaggedError<XaiHostUiError>()("XaiHostUiError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

/** Isolates synchronous Pi UI callbacks from the Effect application error channel. */
const tryHostUi = <A>(operation: string, action: () => A) =>
  Effect.try({
    try: action,
    catch: () =>
      new XaiHostUiError({ operation, message: "Unable to update Better xAI settings UI." }),
  });

/** Best-effort Effect adapter: a failing host UI call is logged, never propagated. */
export const recoverHostUi = <Result>(operation: string, action: () => Result) =>
  tryHostUi(operation, action).pipe(
    Effect.catchTag("XaiHostUiError", () =>
      Effect.logWarning(`Better xAI UI recovery: ${operation}_failed.`),
    ),
    Effect.asVoid,
  );
