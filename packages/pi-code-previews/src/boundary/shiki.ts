import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import { createHighlighter } from "shiki";

export type ShikiHighlighter = Awaited<ReturnType<typeof createHighlighter>>;

export class ShikiBoundaryError extends Schema.TaggedError<ShikiBoundaryError>()(
  "ShikiBoundaryError",
  { operation: Schema.String, message: Schema.String },
) {}

type HighlighterUseState = {
  activeLoads: number;
  disposalRequested: boolean;
  disposalAttempted: boolean;
  reportDisposalFailure: (() => void) | undefined;
};

const highlighterUseStates = new WeakMap<ShikiHighlighter, HighlighterUseState>();

function highlighterUseState(highlighter: ShikiHighlighter): HighlighterUseState {
  const existing = highlighterUseStates.get(highlighter);
  if (existing) return existing;
  const created: HighlighterUseState = {
    activeLoads: 0,
    disposalRequested: false,
    disposalAttempted: false,
    reportDisposalFailure: undefined,
  };
  highlighterUseStates.set(highlighter, created);
  return created;
}

/** Third-party disposal must never defect a replacement, cancellation, or scope finalizer. */
export function disposeShikiHighlighterSafely(highlighter: ShikiHighlighter): boolean {
  try {
    highlighter.dispose();
    return true;
  } catch {
    return false;
  }
}

type HighlighterDisposal = "AlreadyDisposed" | "Deferred" | "Disposed" | "Failed";

function attemptHighlighterDisposal(
  highlighter: ShikiHighlighter,
  state: HighlighterUseState,
): HighlighterDisposal {
  if (state.disposalAttempted) return "AlreadyDisposed";
  state.disposalRequested = true;
  if (state.activeLoads > 0) return "Deferred";
  state.disposalAttempted = true;
  if (disposeShikiHighlighterSafely(highlighter)) return "Disposed";
  try {
    state.reportDisposalFailure?.();
  } catch {
    // A logger captured from the owning runtime is still a hostile callback.
  }
  return "Failed";
}

function beginHighlighterLoad(highlighter: ShikiHighlighter): boolean {
  const state = highlighterUseState(highlighter);
  if (state.disposalRequested || state.disposalAttempted) return false;
  state.activeLoads++;
  return true;
}

function endHighlighterLoad(highlighter: ShikiHighlighter): void {
  const state = highlighterUseState(highlighter);
  if (state.activeLoads > 0) state.activeLoads--;
  if (state.activeLoads === 0 && state.disposalRequested)
    attemptHighlighterDisposal(highlighter, state);
}

export function disposeShikiHighlighter(
  highlighter: ShikiHighlighter | undefined,
): Effect.Effect<void> {
  if (!highlighter) return Effect.void;
  return Effect.gen(function* () {
    const loggers = yield* Logger.CurrentLoggers;
    const fiber = yield* Effect.fiber;
    const disposalRequestedAt = yield* DateTime.nowAsDate;
    const state = highlighterUseState(highlighter);
    state.reportDisposalFailure = () => {
      const options = {
        cause: Cause.empty,
        date: disposalRequestedAt,
        fiber,
        logLevel: "Warn" as const,
        message: "Shiki failed to dispose cleanly; continuing lifecycle cleanup.",
      };
      for (const logger of loggers) {
        try {
          logger.log(options);
        } catch {
          // One hostile logger must not prevent the remaining captured loggers.
        }
      }
    };
    attemptHighlighterDisposal(highlighter, state);
  });
}

type AbortRegistration = {
  readonly aborted: boolean;
  readonly remove: () => void;
};

function registerAbortListener(
  signal: AbortSignal,
  onAbort: () => void,
): AbortRegistration | undefined {
  let registered = false;
  const remove = () => {
    if (!registered) return;
    registered = false;
    try {
      signal.removeEventListener("abort", onAbort);
    } catch {
      // AbortSignal is a host boundary; cleanup must remain no-fail.
    }
  };
  try {
    signal.addEventListener("abort", onAbort, { once: true });
    registered = true;
    const aborted = signal.aborted;
    if (aborted) onAbort();
    return { aborted, remove };
  } catch {
    remove();
    return undefined;
  }
}

export const shikiBoundaryTest = { registerAbortListener };

export interface ShikiAdapterContract {
  readonly create: (
    theme: string,
    languages: readonly string[],
  ) => Effect.Effect<ShikiHighlighter, ShikiBoundaryError>;
  /** Custom adapters must stop using the highlighter when this Effect terminates. */
  readonly loadLanguage: (
    highlighter: ShikiHighlighter,
    language: string,
  ) => Effect.Effect<void, ShikiBoundaryError>;
}

export class ShikiAdapter extends Context.Service<ShikiAdapter, ShikiAdapterContract>()(
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
    let cancelled = false;
    const abort = () => {
      cancelled = true;
    };
    const registration = registerAbortListener(signal, abort);
    if (!registration) {
      resume(
        Effect.fail(
          new ShikiBoundaryError({
            operation: "initialize",
            message: "Unable to initialize syntax highlighting.",
          }),
        ),
      );
      return Effect.void;
    }
    if (registration.aborted || cancelled) return Effect.sync(registration.remove);
    const failInitialization = () => {
      registration.remove();
      if (!cancelled)
        resume(
          Effect.fail(
            new ShikiBoundaryError({
              operation: "initialize",
              message: "Unable to initialize syntax highlighting.",
            }),
          ),
        );
    };
    try {
      // SAFETY: The boundary adapter's ownership and validation checks establish this host contract before use.
      void createHighlighter({ themes: [theme], langs: [...languages] as never[] })
        .then((highlighter) => {
          try {
            if (cancelled) disposeShikiHighlighterSafely(highlighter);
            else resume(Effect.succeed(highlighter));
          } finally {
            registration.remove();
          }
        }, failInitialization)
        .catch(() => undefined);
    } catch {
      failInitialization();
    }
    return Effect.sync(() => {
      cancelled = true;
      registration.remove();
    });
  });
}

function loadShikiLanguage(
  highlighter: ShikiHighlighter,
  language: string,
): Effect.Effect<void, ShikiBoundaryError> {
  // Shiki's Promise has no cancellation API. Interruption therefore releases the Effect caller
  // immediately while this adapter retains a lease; disposal is quarantined until that Promise
  // settles. Test adapters are expected to stop using the highlighter when their Effect ends.
  return Effect.callback<void, ShikiBoundaryError>((resume) => {
    const failure = () =>
      Effect.fail(
        new ShikiBoundaryError({
          operation: "language",
          message: "Unable to load syntax language.",
        }),
      );
    if (!beginHighlighterLoad(highlighter)) {
      resume(failure());
      return Effect.void;
    }
    let cancelled = false;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      endHighlighterLoad(highlighter);
    };
    try {
      // SAFETY: The boundary adapter's ownership and validation checks establish this host contract before use.
      void Promise.resolve(highlighter.loadLanguage(language as never))
        .then(
          () => {
            settle();
            if (!cancelled) resume(Effect.void);
          },
          () => {
            settle();
            if (!cancelled) resume(failure());
          },
        )
        .catch(() => undefined);
    } catch {
      settle();
      resume(failure());
    }
    return Effect.sync(() => {
      cancelled = true;
    });
  });
}
