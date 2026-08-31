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
    generation: current.generation,
    theme: current.theme,
    highlighter: current.highlighter,
    loadedLanguages: Object.freeze([...current.loadedLanguages]),
    status: Object.freeze({
      initialized: current.highlighter !== undefined,
      loadedLanguages: current.loadedLanguages.size,
      pendingLanguages: current.pendingLanguages.size,
      statusVersion: current.statusVersion,
    }),
  });

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
        const decision = yield* modify<InitializeDecision>((current) =>
          Effect.gen(function* () {
            if (current.highlighter && current.theme === theme)
              return [{ tag: "Ready" } as const, current] as const;
            if (current.initialization?.theme === theme)
              return [
                { tag: "Await" as const, done: current.initialization.done },
                current,
              ] as const;
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
          const outcome = yield* Deferred.await(decision.done);
          if (outcome === "Interrupted") return yield* initialize(theme);
          return;
        }

        const { flight } = decision;
        const clearInterruptedFlight = modify((current) =>
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
        ).pipe(Effect.andThen(Deferred.succeed(flight.done, "Interrupted")), Effect.asVoid);
        return yield* Effect.uninterruptibleMask((restore) =>
          restore(adapter.create(theme, PRELOADED_SHIKI_LANGUAGES)).pipe(
            Effect.matchEffect({
              onFailure: () =>
                modify((current) => {
                  if (current.initialization !== flight)
                    return Effect.succeed([undefined, current] as const);
                  // Replacement is transactional: a failed candidate only clears its flight.
                  // The working highlighter and renderer projection remain installed.
                  return Effect.succeed([
                    undefined,
                    {
                      ...current,
                      initialization: undefined,
                      statusVersion: current.statusVersion + 1,
                    },
                  ] as const);
                }).pipe(
                  Effect.andThen(
                    Effect.logWarning(
                      "Shiki failed to initialize; code previews will use plain text.",
                    ),
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
                          statusVersion: current.statusVersion + 1,
                        },
                      ] as const),
                    );
                  }),
                ),
            }),
          ),
        ).pipe(
          Effect.onInterrupt(() => clearInterruptedFlight),
          Effect.ensuring(Deferred.succeed(flight.done, "Completed").pipe(Effect.asVoid)),
          Effect.withSpan("pi-code-previews.shiki.initialize", {
            attributes: { operation: "initialize" },
          }),
        );
      });

      const requestLanguage = Effect.fn("CodePreviewShiki.requestLanguage")(function* (
        language: string,
      ) {
        const decision = yield* modify<LanguageDecision>((current) => {
          if (current.loadedLanguages.has(language) || !current.highlighter)
            return Effect.succeed([undefined, current] as const);
          if (current.pendingLanguages.has(language))
            return Effect.succeed([undefined, current] as const);
          const pending = new Set(current.pendingLanguages);
          pending.add(language);
          return Effect.succeed([
            {
              highlighter: current.highlighter,
              generation: current.generation,
            },
            { ...current, pendingLanguages: pending },
          ] as const);
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
        return yield* loadCurrentGeneration.pipe(
          Effect.matchEffect({
            onFailure: () =>
              modify((current) => {
                if (current.generation !== decision.generation)
                  return Effect.succeed([undefined, current] as const);
                const pending = new Set(current.pendingLanguages);
                pending.delete(language);
                return Effect.succeed([
                  undefined,
                  {
                    ...current,
                    pendingLanguages: pending,
                    statusVersion: current.statusVersion + 1,
                  },
                ] as const);
              }),
            onSuccess: () =>
              modify((current) => {
                if (current.generation !== decision.generation)
                  return Effect.succeed([undefined, current] as const);
                const pending = new Set(current.pendingLanguages);
                pending.delete(language);
                const loaded = new Set(current.loadedLanguages);
                loaded.add(language);
                return Effect.succeed([
                  undefined,
                  {
                    ...current,
                    loadedLanguages: loaded,
                    pendingLanguages: pending,
                    statusVersion: current.statusVersion + 1,
                  },
                ] as const);
              }),
          }),
        );
      });

      const ingress = yield* makeSyntaxIngress(owner, {
        initialize,
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
