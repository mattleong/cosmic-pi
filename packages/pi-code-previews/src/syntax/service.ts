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
  /** Advances whenever the highlighter is installed or released. */
  readonly generation: number;
  readonly initialization: InitializationFlight | undefined;
  readonly loadedLanguages: ReadonlySet<string>;
  readonly pendingLanguages: ReadonlySet<string>;
  /** Themes and grammars that failed this session; renderer requests never retry them. */
  readonly failedThemes: ReadonlySet<string>;
  readonly failedLanguages: ReadonlySet<string>;
  readonly statusVersion: number;
  /** Set by finalization so a late caller cannot create a highlighter nothing would dispose. */
  readonly closed: boolean;
};
/** `superseded` is a pending flight that the decision settled as completed. */
type InitializeDecision =
  | { readonly tag: "Ready" | "Start"; readonly superseded: InitializationFlight | undefined }
  | { readonly tag: "Await"; readonly done: Deferred.Deferred<InitializationOutcome> };

interface CodePreviewSyntaxServiceContract {
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
        closed: false,
      };
      const state = yield* SynchronizedRef.make(initial);
      const highlighterLifecycle = yield* Semaphore.make(1);

      const publish = (current: SyntaxState) =>
        publishSyntaxProjection(owner, syntaxSnapshot(current));
      publish(initial);

      // Transitions are pure: they publish and replace the backing value in one synchronous
      // step, and callers release highlighters or settle flights only after that commit.
      // Lock waiting and the language adapter remain interruptible.
      const modify = <A>(transition: (current: SyntaxState) => readonly [A, SyntaxState]) =>
        SynchronizedRef.modify(state, (current) => {
          const result = transition(current);
          if (result[1] !== current) publish(result[1]);
          return result;
        });

      // The old highlighter is released after the new snapshot no longer publishes it.
      const dispose = highlighterLifecycle.withPermits(1)(
        modify((current) => [
          current.highlighter,
          {
            ...initial,
            generation: current.generation + 1,
            statusVersion: current.statusVersion + 1,
            closed: true,
          },
        ]).pipe(Effect.flatMap(releaseHighlighter)),
      );

      const initialize: (theme: string) => Effect.Effect<void> = Effect.fn(
        "CodePreviewShiki.initialize",
      )(function* (theme: string) {
        if (!codePreviewSettings.syntaxHighlighting) return;
        // Admission and handler installation are one handoff. Only creation and joiner waits
        // restore caller interruption; acquired candidates retain the existing disposal commit.
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const flight: InitializationFlight = {
              theme,
              done: yield* Deferred.make<InitializationOutcome>(),
            };
            const decision = yield* modify<InitializeDecision>((current) => {
              const pending = current.initialization;
              if (current.closed) return [{ tag: "Ready", superseded: undefined }, current];
              // A return to the installed theme supersedes the pending replacement too.
              if (current.highlighter && current.theme === theme)
                return [
                  { tag: "Ready", superseded: pending },
                  pending ? { ...current, initialization: undefined } : current,
                ];
              if (pending?.theme === theme) return [{ tag: "Await", done: pending.done }, current];
              return [
                { tag: "Start", superseded: pending },
                { ...current, initialization: flight },
              ];
            });
            if (decision.tag === "Await") {
              const outcome = yield* restore(Deferred.await(decision.done));
              if (outcome === "Interrupted") return yield* restore(initialize(theme));
              return;
            }
            // Settling as completed prevents superseded joiners from restarting an obsolete request.
            if (decision.superseded) yield* Deferred.succeed(decision.superseded.done, "Completed");
            if (decision.tag === "Ready") return;

            // Replacement is transactional: a failed or interrupted candidate only clears its
            // flight. The working highlighter and renderer projection remain installed.
            const clearFlight = modify((current) =>
              current.initialization === flight
                ? [
                    true,
                    {
                      ...current,
                      initialization: undefined,
                      statusVersion: current.statusVersion + 1,
                    },
                  ]
                : [false, current],
            );
            // A failed theme is remembered for the session so renderers stop requesting it. Only
            // the first failure publishes a new status version and warns; explicit retries stay quiet.
            const recordFailure = modify((current) => {
              const owned = current.initialization === flight;
              const repeated = current.failedThemes.has(theme);
              if (repeated && !owned) return [false, current];
              return [
                !repeated,
                {
                  ...current,
                  initialization: owned ? undefined : current.initialization,
                  failedThemes: repeated
                    ? current.failedThemes
                    : new Set(current.failedThemes).add(theme),
                  statusVersion: repeated ? current.statusVersion : current.statusVersion + 1,
                },
              ];
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
                // Installs the candidate only while its flight is current; whichever highlighter
                // loses is released after the commit.
                onSuccess: (next) =>
                  highlighterLifecycle.withPermits(1)(
                    modify((current) =>
                      current.initialization !== flight
                        ? [next, current]
                        : [
                            current.highlighter,
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
                          ],
                    ).pipe(Effect.flatMap(releaseHighlighter)),
                  ),
              }),
              // Only the current owner's interruption lets joiners retry; a superseded flight
              // completes even if its successor has not settled it yet.
              Effect.onInterrupt(() =>
                clearFlight.pipe(
                  Effect.flatMap((owned) =>
                    Deferred.succeed(flight.done, owned ? "Interrupted" : "Completed"),
                  ),
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
        // Every highlighter change advances the generation, so it alone identifies the target.
        const generation = yield* modify((current) =>
          !current.highlighter ||
          current.loadedLanguages.has(language) ||
          current.pendingLanguages.has(language) ||
          current.failedLanguages.has(language)
            ? [undefined, current]
            : [
                current.generation,
                { ...current, pendingLanguages: new Set(current.pendingLanguages).add(language) },
              ],
        );
        if (generation === undefined) return;
        const succeeded = yield* Effect.isSuccess(
          highlighterLifecycle.withPermits(1)(
            SynchronizedRef.get(state).pipe(
              Effect.flatMap((current) =>
                current.generation === generation && current.highlighter
                  ? adapter.loadLanguage(current.highlighter, language)
                  : Effect.void,
              ),
            ),
          ),
        );
        yield* modify((current) =>
          current.generation !== generation
            ? [undefined, current]
            : [
                undefined,
                {
                  ...current,
                  loadedLanguages: succeeded
                    ? new Set(current.loadedLanguages).add(language)
                    : current.loadedLanguages,
                  pendingLanguages: withoutEntry(current.pendingLanguages, language),
                  // A grammar that failed stays plain for the session instead of being requested again.
                  failedLanguages: succeeded
                    ? current.failedLanguages
                    : new Set(current.failedLanguages).add(language),
                  statusVersion: current.statusVersion + 1,
                },
              ],
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

      yield* Effect.addFinalizer(() =>
        ingress.shutdown.pipe(
          Effect.andThen(dispose),
          Effect.ensuring(Effect.sync(() => clearSyntaxProjection(owner))),
        ),
      );
      return CodePreviewSyntaxService.of({ initialize });
    }),
  );
}
