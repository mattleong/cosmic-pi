import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import type { createHighlighter } from "shiki/bundle/full";
import { isShikiLanguage } from "../syntax/language";

export type ShikiHighlighter = Awaited<ReturnType<typeof createHighlighter>>;

export class ShikiBoundaryError extends Schema.TaggedError<
  ShikiBoundaryError,
  { readonly brand: unique symbol }
>()("ShikiBoundaryError", { operation: Schema.String, message: Schema.String }) {}

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

export function disposeShikiHighlighterSafely(highlighter: ShikiHighlighter): boolean {
  try {
    highlighter.dispose();
    return true;
  } catch {
    return false;
  }
}

function attemptHighlighterDisposal(
  highlighter: ShikiHighlighter,
  state: HighlighterUseState,
): void {
  if (state.disposalAttempted) return;
  state.disposalRequested = true;
  if (state.activeLoads > 0) return;
  state.disposalAttempted = true;
  if (!disposeShikiHighlighterSafely(highlighter))
    invokeHostCallback(() => state.reportDisposalFailure?.(), undefined);
}

function beginHighlighterLoad(highlighter: ShikiHighlighter): boolean {
  const state = highlighterUseState(highlighter);
  if (state.disposalRequested) return false;
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
    const services = yield* Effect.context();
    const state = highlighterUseState(highlighter);
    state.reportDisposalFailure = () =>
      Effect.runSyncWith(services)(
        Effect.logWarning("Shiki failed to dispose cleanly; continuing lifecycle cleanup."),
      );
    attemptHighlighterDisposal(highlighter, state);
  });
}

export interface ShikiAdapterContract {
  readonly create: (
    theme: string,
    languages: readonly string[],
  ) => Effect.Effect<ShikiHighlighter, ShikiBoundaryError>;
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

export function createShikiHighlighter(
  theme: string,
  languages: readonly string[],
  load: () => Promise<typeof createHighlighter> = () =>
    import("shiki/bundle/full").then((module) => module.createHighlighter),
): Effect.Effect<ShikiHighlighter, ShikiBoundaryError> {
  return Effect.callback<ShikiHighlighter, ShikiBoundaryError>((resume) => {
    let cancelled = false;
    const failInitialization = () => {
      if (!cancelled)
        resume(
          Effect.fail(
            ShikiBoundaryError.make({
              operation: "initialize",
              message: "Unable to initialize syntax highlighting.",
            }),
          ),
        );
    };
    try {
      // Import and creation are not cancellable. A retired owner must not begin creation after
      // import, and a highlighter already being created is disposed on late settlement.
      void load()
        .then((create) => {
          if (cancelled) return undefined;
          return create({ themes: [theme], langs: [...languages] }).then((highlighter) => {
            if (cancelled) disposeShikiHighlighterSafely(highlighter);
            else resume(Effect.succeed(highlighter));
            return undefined;
          });
        })
        .catch(failInitialization);
    } catch {
      failInitialization();
    }
    return Effect.sync(() => {
      cancelled = true;
    });
  });
}

function loadShikiLanguage(
  highlighter: ShikiHighlighter,
  language: string,
): Effect.Effect<void, ShikiBoundaryError> {
  return Effect.callback<void, ShikiBoundaryError>((resume) => {
    const failure = () =>
      Effect.fail(
        ShikiBoundaryError.make({
          operation: "language",
          message: "Unable to load syntax language.",
        }),
      );
    if (!isShikiLanguage(language) || !beginHighlighterLoad(highlighter)) {
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
      void Promise.resolve(highlighter.loadLanguage(language))
        .then(
          () => {
            settle();
            if (!cancelled) resume(Effect.void);
            return undefined;
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
