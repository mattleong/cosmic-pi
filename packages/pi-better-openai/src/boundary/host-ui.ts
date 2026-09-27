import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  captureHostSignal,
  invokeHostCallback,
  sanitizeDiagnosticError,
  notifyAtHostBoundary,
} from "pi-cosmic-core";

/** Best-effort Effect adapter for synchronous Pi UI callbacks. */
export const ignoreHostUi = <Result>(callback: () => Result) =>
  Effect.sync(() => {
    invokeHostCallback<Result | undefined>(callback, undefined);
  });

/** Best-effort adapter for Pi callbacks that cannot enter the session runtime. */
export function safeHostUi<Result>(callback: () => Result): void {
  invokeHostCallback(callback, undefined);
}

/** Materializes Pi's dynamic cancellation signal without allowing a host getter to defect. */
export function safeHostSignal(ctx: ExtensionContext): AbortSignal | undefined {
  const captured = captureHostSignal(ctx);
  return captured._tag === "Captured" ? captured.signal : undefined;
}

/** Contains a host command: typed failures and defects warn, interrupts stay silent. */
export const containCommandFailure = <A, E extends { readonly message: string }, R>(
  effect: Effect.Effect<A, E, R>,
  ctx: ExtensionContext,
  messages: {
    readonly failed: (sanitized: string) => string;
    readonly unexpected: string;
    readonly defect: string;
  },
): Effect.Effect<Option.Option<A>, never, R> =>
  effect.pipe(
    Effect.asSome,
    Effect.catch((error) =>
      Effect.sync(() =>
        notifyAtHostBoundary(
          ctx,
          messages.failed(sanitizeDiagnosticError(error.message)),
          "warning",
        ),
      ).pipe(Effect.as(Option.none())),
    ),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.succeedNone
        : Effect.logError(messages.defect).pipe(
            Effect.andThen(
              Effect.sync(() => notifyAtHostBoundary(ctx, messages.unexpected, "warning")),
            ),
            Effect.as(Option.none()),
          ),
    ),
  );
