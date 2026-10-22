import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import { AskUserAsyncError, AskUserRuntimeClosedError } from "./errors.ts";

export const MAX_PENDING_QUESTIONNAIRES = 16;
export interface QuestionnaireTicket {
  readonly immediate: boolean;
  readonly run: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | AskUserRuntimeClosedError>;
  readonly close: Effect.Effect<void>;
}

export const acquireQuestionnaireQueue = Effect.gen(function* () {
  const parent = yield* Effect.scope;
  const scope = yield* Scope.fork(parent, "sequential");
  const state = yield* Ref.make<{
    readonly pending: number;
    readonly tail: Deferred.Deferred<void> | undefined;
    readonly closed: boolean;
  }>({
    pending: 0,
    tail: undefined,
    closed: false,
  });
  const closing = yield* Deferred.make<void>();
  // Owners that interrupt presenters must call this first; otherwise an interrupted presenter's
  // cleanup would advance the queue and mount a waiting successor during shutdown.
  const closeAdmission = Ref.update(state, (current) => ({ ...current, closed: true })).pipe(
    Effect.andThen(Deferred.succeed(closing, undefined)),
    Effect.asVoid,
  );
  yield* Scope.addFinalizer(parent, closeAdmission);
  const admit = Effect.gen(function* () {
    const done = yield* Deferred.make<void>();
    const admitted = yield* Ref.modify(state, (current) =>
      current.closed || current.pending >= MAX_PENDING_QUESTIONNAIRES
        ? ([undefined, current] as const)
        : ([
            { previous: current.tail, immediate: current.pending === 0 },
            { ...current, pending: current.pending + 1, tail: done },
          ] as const),
    );
    if (!admitted)
      return yield* new AskUserAsyncError({
        reason: "busy",
        message:
          "The session questionnaire queue is full. Await or cancel an existing request before asking again.",
      });
    const released = yield* Ref.make(false);
    const previous = admitted.previous ? Deferred.await(admitted.previous) : Effect.void;
    const ready = admitted.previous
      ? Effect.raceFirst(previous, Deferred.await(closing))
      : Effect.void;
    const drain = previous.pipe(
      Effect.andThen(
        Ref.update(state, (current) => ({ ...current, pending: current.pending - 1 })),
      ),
      Effect.andThen(Deferred.succeed(done, undefined)),
      Effect.asVoid,
    );
    const close = Effect.uninterruptible(
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(released, true)) return;
        if ((yield* Ref.get(state)).closed) return;
        if (!admitted.previous || (yield* Deferred.isDone(admitted.previous))) yield* drain;
        else yield* Effect.forkIn(Effect.interruptible(drain), scope);
      }),
    );
    const ticket: QuestionnaireTicket = {
      immediate: admitted.immediate,
      run: <A, E>(effect: Effect.Effect<A, E>) =>
        ready.pipe(
          Effect.andThen(Deferred.isDone(closing)),
          Effect.flatMap(
            (closed): Effect.Effect<A, E | AskUserRuntimeClosedError> =>
              closed
                ? Effect.fail(
                    new AskUserRuntimeClosedError({
                      message: "The questionnaire session closed before this questionnaire opened.",
                    }),
                  )
                : effect,
          ),
        ),
      close,
    };
    return ticket;
  });
  return { admit, close: closeAdmission };
});
export type QuestionnaireQueue = Effect.Success<typeof acquireQuestionnaireQueue>;
