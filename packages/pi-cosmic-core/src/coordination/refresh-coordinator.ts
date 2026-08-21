import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as SynchronizedRef from "effect/SynchronizedRef";

/** Flags shared by subscription-usage refresh loops. */
export interface RefreshRequest {
  readonly notify?: boolean;
  readonly force?: boolean;
}

interface State<Request, E> {
  readonly active: Deferred.Deferred<void, E> | undefined;
  readonly queued: { readonly value: Request } | undefined;
}

type Registration<E> =
  | { readonly owner: true; readonly done: Deferred.Deferred<void, E> }
  | { readonly owner: false; readonly done: Deferred.Deferred<void, E> };

export const mergeRefreshRequest = (
  current: RefreshRequest | undefined,
  next: RefreshRequest,
): RefreshRequest => ({
  notify: current?.notify === true || next.notify === true,
  force: current?.force === true || next.force === true,
});

/** Generic single-flight coordinator: concurrent requests merge into one queued request that the owner drains until it observes the queue empty while releasing ownership. */
export const makeRefreshCoordinatorWith = <Request, E = never>(
  merge: (current: Request | undefined, next: Request) => Request,
) =>
  Effect.gen(function* () {
    const state = yield* SynchronizedRef.make<State<Request, E>>({
      active: undefined,
      queued: undefined,
    });

    const run = <R>(
      request: Request,
      operation: (request: Request) => Effect.Effect<void, E, R>,
    ): Effect.Effect<void, E, R> =>
      Effect.gen(function* () {
        const registration = yield* SynchronizedRef.modifyEffect(
          state,
          (current): Effect.Effect<readonly [Registration<E>, State<Request, E>]> => {
            if (current.active) {
              // Merging stays open for the whole cycle so a request that arrives while a
              // follow-up executes is queued and drained instead of resolving unexecuted.
              const next: State<Request, E> = {
                ...current,
                queued: { value: merge(current.queued?.value, request) },
              };
              const registration: Registration<E> = { owner: false, done: current.active };
              return Effect.succeed([registration, next] as const);
            }
            return Deferred.make<void, E>().pipe(
              Effect.map((done): readonly [Registration<E>, State<Request, E>] => [
                { owner: true, done },
                { active: done, queued: undefined },
              ]),
            );
          },
        );
        if (!registration.owner) return yield* Deferred.await(registration.done);

        const work = Effect.gen(function* () {
          let pending: { readonly value: Request } | undefined = { value: request };
          while (pending !== undefined) {
            yield* operation(pending.value);
            // Taking the queue and releasing ownership is one serialized transition:
            // a non-empty queue keeps ownership (so later arrivals still merge), and an
            // empty queue ends the cycle in that same step, leaving no lost-request window.
            pending = yield* SynchronizedRef.modifyEffect(state, (current) => {
              if (current.active !== registration.done)
                return Effect.succeed([undefined, current] as const);
              const queued = current.queued;
              return queued !== undefined
                ? Effect.succeed([queued, { active: current.active, queued: undefined }] as const)
                : Effect.succeed([undefined, { active: undefined, queued: undefined }] as const);
            });
          }
        });
        return yield* Effect.uninterruptibleMask((restore) =>
          restore(work).pipe(
            Effect.onExit((exit) =>
              SynchronizedRef.modifyEffect(state, (current) =>
                Effect.succeed([
                  undefined,
                  current.active === registration.done
                    ? { active: undefined, queued: undefined }
                    : current,
                ] as const),
              ).pipe(Effect.andThen(Deferred.done(registration.done, exit)), Effect.asVoid),
            ),
          ),
        );
      });

    return { run } as const;
  });
