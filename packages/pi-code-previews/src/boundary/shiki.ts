import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createHighlighter } from "shiki";

export type ShikiHighlighter = Awaited<ReturnType<typeof createHighlighter>>;

export class ShikiBoundaryError extends Schema.TaggedErrorClass<ShikiBoundaryError>()(
  "ShikiBoundaryError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface ShikiAdapterShape {
  readonly create: (
    theme: string,
    languages: readonly string[],
  ) => Effect.Effect<ShikiHighlighter, ShikiBoundaryError>;
  readonly loadLanguage: (
    highlighter: ShikiHighlighter,
    language: string,
  ) => Effect.Effect<void, ShikiBoundaryError>;
}

export class ShikiAdapter extends Context.Service<ShikiAdapter, ShikiAdapterShape>()(
  "pi-code-previews/boundary/shiki/ShikiAdapter",
) {
  static readonly live = this.of({
    create: createShikiHighlighter,
    loadLanguage: loadShikiLanguage,
  });
  static readonly layer = Layer.succeed(this, this.live);
}

/** Interruptible adapter that disposes a highlighter which resolves after cancellation. */
function createShikiHighlighter(
  theme: string,
  languages: readonly string[],
): Effect.Effect<ShikiHighlighter, ShikiBoundaryError> {
  return Effect.callback<ShikiHighlighter, ShikiBoundaryError>((resume, signal) => {
    let cancelled = signal.aborted;
    const abort = () => {
      cancelled = true;
    };
    signal.addEventListener("abort", abort, { once: true });
    createHighlighter({ themes: [theme], langs: [...languages] as never[] }).then(
      (highlighter) => {
        if (cancelled) highlighter.dispose();
        else resume(Effect.succeed(highlighter));
        signal.removeEventListener("abort", abort);
      },
      () => {
        signal.removeEventListener("abort", abort);
        resume(
          Effect.fail(
            new ShikiBoundaryError({
              operation: "initialize",
              message: "Unable to initialize syntax highlighting.",
            }),
          ),
        );
      },
    );
    return Effect.sync(() => {
      cancelled = true;
      signal.removeEventListener("abort", abort);
    });
  });
}

function loadShikiLanguage(
  highlighter: ShikiHighlighter,
  language: string,
): Effect.Effect<void, ShikiBoundaryError> {
  return Effect.tryPromise({
    try: () => highlighter.loadLanguage(language as never),
    catch: () =>
      new ShikiBoundaryError({
        operation: "language",
        message: "Unable to load syntax language.",
      }),
  });
}
