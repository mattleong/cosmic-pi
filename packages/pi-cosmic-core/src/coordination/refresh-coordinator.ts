import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

/** Flags shared by subscription-usage refresh loops. */
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

/** Concurrent refreshes merge into one queued request, drained until the owner atomically observes an empty queue and releases ownership. */
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
          // Registration must not outlive the finalizer that releases this ownership.
          const candidate = yield* Deferred.make<void, E>();
          const done = yield* Ref.modify(
            state,
            (current): readonly [Deferred.Deferred<void, E>, State<E>] => {
              if (current.active) {
                // Merging stays open for the whole cycle so a request that arrives while a
                // follow-up executes is queued and drained instead of resolving unexecuted.
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
              // Taking the queue and releasing ownership is one atomic transition:
              // a non-empty queue keeps ownership (so later arrivals still merge), and an
              // empty queue ends the cycle in that same step, leaving no lost-request window.
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
