import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

export interface RefreshRequest {
  readonly notify?: boolean;
  readonly force?: boolean;
}

interface State<E> {
  readonly active: Deferred.Deferred<void, E> | undefined;
  readonly queued: RefreshRequest | undefined;
}

const mergeRefreshRequest = (
  current: RefreshRequest | undefined,
  next: RefreshRequest,
): RefreshRequest => ({
  notify: current?.notify === true || next.notify === true,
  force: current?.force === true || next.force === true,
});

export const makeRefreshCoordinator = <E = never>() =>
  Effect.gen(function* () {
    const state = yield* Ref.make<State<E>>({
      active: undefined,
      queued: undefined,
    });

    const run = <R>(
      request: RefreshRequest,
      operation: (request: RefreshRequest) => Effect.Effect<void, E, R>,
    ): Effect.Effect<void, E, R> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const candidate = yield* Deferred.make<void, E>();
          const done = yield* Ref.modify(
            state,
            (current): readonly [Deferred.Deferred<void, E>, State<E>] => {
              if (current.active) {
                return [
                  current.active,
                  { ...current, queued: mergeRefreshRequest(current.queued, request) },
                ];
              }
              return [candidate, { active: candidate, queued: undefined }];
            },
          );
          if (done !== candidate) return yield* restore(Deferred.await(done));

          const work = Effect.gen(function* () {
            let pending: RefreshRequest | undefined = request;
            while (pending !== undefined) {
              yield* operation(pending);
              pending = yield* Ref.modify(state, (current) => {
                if (current.active !== candidate) return [undefined, current] as const;
                const queued = current.queued;
                return queued !== undefined
                  ? ([queued, { active: current.active, queued: undefined }] as const)
                  : ([undefined, { active: undefined, queued: undefined }] as const);
              });
            }
          });
          return yield* restore(work).pipe(
            Effect.onExit((exit) =>
              Ref.update(state, (current) =>
                current.active === candidate ? { active: undefined, queued: undefined } : current,
              ).pipe(Effect.andThen(Deferred.done(candidate, exit)), Effect.asVoid),
            ),
          );
        }),
      );

    return { run } as const;
  });
