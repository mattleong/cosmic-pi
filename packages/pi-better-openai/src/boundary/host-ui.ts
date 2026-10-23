import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { captureHostSignal, notifyAtHostBoundary } from "pi-cosmic-core/host-session";
import { sanitizeDiagnosticError } from "pi-cosmic-core/security";

export function safeHostSignal(ctx: ExtensionContext): AbortSignal | undefined {
  const captured = captureHostSignal(ctx);
  return Predicate.isTagged(captured, "Captured") ? captured.signal : undefined;
}

export const containCommandFailure = <A, E extends { readonly message: string }, R>(
  effect: Effect.Effect<A, E, R>,
  ctx: ExtensionContext,
  messages: {
    readonly failed: (sanitized: string) => string;
    readonly unexpected: string;
    readonly defect: string;
  },
  isCurrent: () => boolean = () => true,
): Effect.Effect<Option.Option<A>, never, R> =>
  effect.pipe(
    Effect.asSome,
    Effect.catch((error) =>
      Effect.sync(() => {
        if (!isCurrent()) return;
        notifyAtHostBoundary(
          ctx,
          messages.failed(sanitizeDiagnosticError(error.message)),
          "warning",
        );
      }).pipe(Effect.as(Option.none())),
    ),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.succeedNone
        : Effect.logError(messages.defect).pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (isCurrent()) notifyAtHostBoundary(ctx, messages.unexpected, "warning");
              }),
            ),
            Effect.as(Option.none()),
          ),
    ),
  );
