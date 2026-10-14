import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { acquireProjectionOwnership } from "../shared/projection-ownership";
import { disposeShikiHighlighter, ShikiAdapter, type ShikiHighlighter } from "../boundary/shiki";
import { codePreviewSettings } from "../config/state";
import { acquireSyntaxIngress } from "./ingress";
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
  readonly failedThemes: ReadonlySet<string>;
  readonly failedLanguages: ReadonlySet<string>;
  readonly statusVersion: number;
  readonly closed: boolean;
};
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

      const modify = <A>(transition: (current: SyntaxState) => readonly [A, SyntaxState]) =>
        SynchronizedRef.modify(state, (current) => {
          const result = transition(current);
          if (result[1] !== current) publish(result[1]);
          return result;
        });

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
        if (!codePreviewSettings.syntaxHighlighting) return undefined;
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const flight: InitializationFlight = {
              theme,
              done: yield* Deferred.make<InitializationOutcome>(),
            };
            const decision = yield* modify<InitializeDecision>((current) => {
              const pending = current.initialization;
              if (current.closed) return [{ tag: "Ready", superseded: undefined }, current];
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
              return undefined;
            }
            if (decision.superseded) yield* Deferred.succeed(decision.superseded.done, "Completed");
            if (decision.tag === "Ready") return undefined;

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
                  failedLanguages: succeeded
                    ? current.failedLanguages
                    : new Set(current.failedLanguages).add(language),
                  statusVersion: current.statusVersion + 1,
                },
              ],
        );
      });

      const requestInitialize = (theme: string): Effect.Effect<void> =>
        SynchronizedRef.get(state).pipe(
          Effect.flatMap((current) =>
            current.failedThemes.has(theme) ? Effect.void : initialize(theme),
          ),
        );

      const ingress = yield* acquireSyntaxIngress(owner, {
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
