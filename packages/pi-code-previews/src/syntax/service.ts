import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { acquireProjectionOwnership } from "../shared/projection-ownership";
import { disposeShikiHighlighter, ShikiAdapter, type ShikiHighlighter } from "../boundary/shiki";
import { codePreviewSettings } from "../config/state";
import { makeSyntaxIngress } from "./ingress";
import {
  clearSyntaxProjection,
  publishSyntaxProjection,
  type CodePreviewSyntaxSnapshot,
} from "./projection";
import { discardShikiRenderCache } from "./render";

const PRELOADED_SHIKI_LANGUAGES = [
  "bash",
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "markdown",
  "diff",
  "yaml",
] as const;

type InitializationOutcome = "Completed" | "Interrupted";
type InitializationFlight = {
  readonly theme: string;
  readonly done: Deferred.Deferred<InitializationOutcome>;
};
type SyntaxState = {
  readonly highlighter: ShikiHighlighter | undefined;
  readonly theme: string | undefined;
  readonly generation: number;
  readonly initialization: InitializationFlight | undefined;
  readonly loadedLanguages: ReadonlySet<string>;
  readonly pendingLanguages: ReadonlySet<string>;
  /** Themes and grammars that failed this session; renderer requests never retry them. */
  readonly failedThemes: ReadonlySet<string>;
  readonly failedLanguages: ReadonlySet<string>;
  readonly statusVersion: number;
};
type InitializeDecision =
  | { readonly tag: "Ready" }
  | { readonly tag: "Await"; readonly done: Deferred.Deferred<InitializationOutcome> }
  | { readonly tag: "Start"; readonly flight: InitializationFlight };
type LanguageDecision =
  | {
      readonly highlighter: ShikiHighlighter;
      readonly generation: number;
    }
  | undefined;

export interface CodePreviewSyntaxServiceContract {
  readonly initialize: (theme: string) => Effect.Effect<void>;
}

const syntaxSnapshot = (current: SyntaxState): CodePreviewSyntaxSnapshot =>
  Object.freeze({
    theme: current.theme,
    highlighter: current.highlighter,
    loadedLanguages: Object.freeze([...current.loadedLanguages]),
    failedThemes: Object.freeze([...current.failedThemes]),
    failedLanguages: Object.freeze([...current.failedLanguages]),
    status: Object.freeze({
      initialized: current.highlighter !== undefined,
      loadedLanguages: current.loadedLanguages.size,
      pendingLanguages: current.pendingLanguages.size,
      statusVersion: current.statusVersion,
    }),
  });

const withoutEntry = (entries: ReadonlySet<string>, entry: string): ReadonlySet<string> => {
  if (!entries.has(entry)) return entries;
  const remaining = new Set(entries);
  remaining.delete(entry);
  return remaining;
};

/** Clears only this highlighter's render cache before requesting third-party disposal. */
const releaseHighlighter = (highlighter: ShikiHighlighter | undefined): Effect.Effect<void> => {
  if (!highlighter) return Effect.void;
  return Effect.sync(() => discardShikiRenderCache(highlighter)).pipe(
    Effect.andThen(disposeShikiHighlighter(highlighter)),
  );
};

export class CodePreviewSyntaxService extends Context.Service<
  CodePreviewSyntaxService,
  CodePreviewSyntaxServiceContract
>()("pi-code-previews/syntax/service/CodePreviewSyntaxService") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const adapter = yield* ShikiAdapter;
      const owner = acquireProjectionOwnership("code-preview-syntax-projection");
      const initial: SyntaxState = {
        highlighter: undefined,
        theme: undefined,
        generation: 0,
        initialization: undefined,
        loadedLanguages: new Set(),
        pendingLanguages: new Set(),
        failedThemes: new Set(),
        failedLanguages: new Set(),
        statusVersion: 0,
      };
      const state = yield* SynchronizedRef.make(initial);
      const highlighterLifecycle = yield* Semaphore.make(1);

      const publish = (current: SyntaxState) =>
        publishSyntaxProjection(owner, syntaxSnapshot(current));
      publish(initial);

      const modify = <A>(
        transition: (current: SyntaxState) => Effect.Effect<readonly [A, SyntaxState]>,
      ) =>
        SynchronizedRef.modifyEffect(state, (current) =>
          transition(current).pipe(
            Effect.tap(([, next]) =>
              next === current ? Effect.void : Effect.sync(() => publish(next)),
            ),
          ),
        );

      // Pure transitions publish and replace the backing value in one synchronous step.
      // Lock waiting and the language adapter remain interruptible.
      const modifyPure = <A>(transition: (current: SyntaxState) => readonly [A, SyntaxState]) =>
        SynchronizedRef.modify(state, (current) => {
          const result = transition(current);
          if (result[1] !== current) publish(result[1]);
          return result;
        });

      const dispose = highlighterLifecycle.withPermits(1)(
        modify((current) =>
          releaseHighlighter(current.highlighter).pipe(
            Effect.as([
              undefined,
              {
                ...initial,
                generation: current.generation + 1,
                statusVersion: current.statusVersion + 1,
              },
            ] as const),
          ),
        ),
      );

      const initialize: (theme: string) => Effect.Effect<void> = Effect.fn(
        "CodePreviewShiki.initialize",
      )(function* (theme: string) {
        if (!codePreviewSettings.syntaxHighlighting) return;
        // Admission and handler installation are one handoff. Only creation and joiner waits
        // restore caller interruption; acquired candidates retain the existing disposal commit.
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const decision = yield* modify<InitializeDecision>((current) =>
              Effect.gen(function* () {
                if (current.highlighter && current.theme === theme) {
                  if (!current.initialization) return [{ tag: "Ready" } as const, current] as const;
                  // A return to the installed theme supersedes the pending replacement too.
                  // Settling as completed prevents its joiners from restarting an obsolete request.
                  yield* Deferred.succeed(current.initialization.done, "Completed");
                  return [
                    { tag: "Ready" } as const,
                    { ...current, initialization: undefined },
                  ] as const;
                }
                if (current.initialization?.theme === theme)
                  return [
                    { tag: "Await" as const, done: current.initialization.done },
                    current,
                  ] as const;
                if (current.initialization)
                  yield* Deferred.succeed(current.initialization.done, "Completed");
                const done = yield* Deferred.make<InitializationOutcome>();
                const flight = { theme, done } satisfies InitializationFlight;
                return [
                  { tag: "Start" as const, flight },
                  { ...current, initialization: flight },
                ] as const;
              }),
            );
            if (decision.tag === "Ready") return;
            if (decision.tag === "Await") {
              const outcome = yield* restore(Deferred.await(decision.done));
              if (outcome === "Interrupted") return yield* restore(initialize(theme));
              return;
            }

            const { flight } = decision;
            // Replacement is transactional: a failed or interrupted candidate only clears its
            // flight. The working highlighter and renderer projection remain installed.
            const clearFlight = modify((current) =>
              Effect.succeed([
                undefined,
                current.initialization === flight
                  ? {
                      ...current,
                      initialization: undefined,
                      statusVersion: current.statusVersion + 1,
                    }
                  : current,
              ] as const),
            );
            // A failed theme is remembered for the session so renderers stop requesting it. Only
            // the first failure publishes a new status version and warns; explicit retries stay quiet.
            const recordFailure = modify((current) => {
              const owned = current.initialization === flight;
              const repeated = current.failedThemes.has(theme);
              if (repeated && !owned) return Effect.succeed([false, current] as const);
              return Effect.succeed([
                !repeated,
                {
                  ...current,
                  initialization: owned ? undefined : current.initialization,
                  failedThemes: repeated
                    ? current.failedThemes
                    : new Set(current.failedThemes).add(theme),
                  statusVersion: repeated ? current.statusVersion : current.statusVersion + 1,
                },
              ] as const);
            });
            return yield* restore(adapter.create(theme, PRELOADED_SHIKI_LANGUAGES)).pipe(
              Effect.matchEffect({
                onFailure: () =>
                  recordFailure.pipe(
                    Effect.flatMap((firstFailure) =>
                      firstFailure
                        ? Effect.logWarning(
                            "Shiki failed to initialize; code previews will use plain text.",
                          )
                        : Effect.void,
                    ),
                  ),
                onSuccess: (next) =>
                  highlighterLifecycle.withPermits(1)(
                    modify((current) => {
                      if (current.initialization !== flight)
                        return releaseHighlighter(next).pipe(
                          Effect.as([undefined, current] as const),
                        );
                      return releaseHighlighter(current.highlighter).pipe(
                        Effect.as([
                          undefined,
                          {
                            ...current,
                            highlighter: next,
                            theme,
                            generation: current.generation + 1,
                            initialization: undefined,
                            loadedLanguages: new Set(PRELOADED_SHIKI_LANGUAGES),
                            pendingLanguages: new Set(),
                            failedThemes: withoutEntry(current.failedThemes, theme),
                            statusVersion: current.statusVersion + 1,
                          },
                        ] as const),
                      );
                    }),
                  ),
              }),
              Effect.onInterrupt(() =>
                clearFlight.pipe(
                  Effect.andThen(Deferred.succeed(flight.done, "Interrupted")),
                  Effect.asVoid,
                ),
              ),
              Effect.ensuring(Deferred.succeed(flight.done, "Completed").pipe(Effect.asVoid)),
              Effect.withSpan("pi-code-previews.shiki.initialize", {
                attributes: { operation: "initialize" },
              }),
            );
          }),
        );
      });

      const requestLanguage = Effect.fn("CodePreviewShiki.requestLanguage")(function* (
        language: string,
      ) {
        const decision = yield* modifyPure<LanguageDecision>((current) => {
          if (current.loadedLanguages.has(language) || !current.highlighter)
            return [undefined, current] as const;
          if (current.pendingLanguages.has(language) || current.failedLanguages.has(language))
            return [undefined, current] as const;
          const pending = new Set(current.pendingLanguages);
          pending.add(language);
          return [
            {
              highlighter: current.highlighter,
              generation: current.generation,
            },
            { ...current, pendingLanguages: pending },
          ] as const;
        });
        if (!decision) return;
        const loadCurrentGeneration = highlighterLifecycle.withPermits(1)(
          SynchronizedRef.get(state).pipe(
            Effect.flatMap((current) =>
              current.generation === decision.generation &&
              current.highlighter === decision.highlighter
                ? adapter.loadLanguage(decision.highlighter, language)
                : Effect.void,
            ),
          ),
        );
        return yield* Effect.isSuccess(loadCurrentGeneration).pipe(
          Effect.flatMap((succeeded) =>
            modifyPure((current) => {
              if (current.generation !== decision.generation) return [undefined, current] as const;
              const pending = new Set(current.pendingLanguages);
              pending.delete(language);
              const loaded = succeeded
                ? new Set(current.loadedLanguages).add(language)
                : current.loadedLanguages;
              // A grammar that failed stays plain for the session instead of being requested again.
              const failed = succeeded
                ? current.failedLanguages
                : new Set(current.failedLanguages).add(language);
              return [
                undefined,
                {
                  ...current,
                  loadedLanguages: loaded,
                  pendingLanguages: pending,
                  failedLanguages: failed,
                  statusVersion: current.statusVersion + 1,
                },
              ] as const;
            }),
          ),
        );
      });

      // Renderer requests skip a theme that already failed; explicit initialization still retries.
      const requestInitialize = (theme: string): Effect.Effect<void> =>
        SynchronizedRef.get(state).pipe(
          Effect.flatMap((current) =>
            current.failedThemes.has(theme) ? Effect.void : initialize(theme),
          ),
        );

      const ingress = yield* makeSyntaxIngress(owner, {
        initialize: requestInitialize,
        language: requestLanguage,
      });

      const service = CodePreviewSyntaxService.of({ initialize });

      return yield* Effect.acquireRelease(Effect.succeed(service), () =>
        ingress.shutdown.pipe(
          Effect.andThen(dispose),
          Effect.ensuring(Effect.sync(() => clearSyntaxProjection(owner))),
        ),
      );
    }),
  );
}
