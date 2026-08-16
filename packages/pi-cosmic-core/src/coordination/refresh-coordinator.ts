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
  readonly acceptingFollowUp: boolean;
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

/** Generic single-flight coordinator with one bounded, merged follow-up. */
export const makeRefreshCoordinatorWith = <Request, E = never>(
  merge: (current: Request | undefined, next: Request) => Request,
) =>
  Effect.gen(function* () {
    const state = yield* SynchronizedRef.make<State<Request, E>>({
      active: undefined,
      queued: undefined,
      acceptingFollowUp: false,
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
              const next: State<Request, E> = current.acceptingFollowUp
                ? {
                    ...current,
                    queued: { value: merge(current.queued?.value, request) },
                  }
                : current;
              const registration: Registration<E> = { owner: false, done: current.active };
              return Effect.succeed([registration, next] as const);
            }
            return Deferred.make<void, E>().pipe(
              Effect.map((done): readonly [Registration<E>, State<Request, E>] => [
                { owner: true, done },
                { active: done, queued: undefined, acceptingFollowUp: true },
              ]),
            );
          },
        );
        if (!registration.owner) return yield* Deferred.await(registration.done);

        const work = Effect.gen(function* () {
          yield* operation(request);
          const followUp = yield* SynchronizedRef.modifyEffect(state, (current) =>
            Effect.succeed([
              current.queued,
              { ...current, queued: undefined, acceptingFollowUp: false },
            ] as const),
          );
          if (followUp !== undefined) yield* operation(followUp.value);
        });
        return yield* Effect.uninterruptibleMask((restore) =>
          restore(work).pipe(
            Effect.onExit((exit) =>
              SynchronizedRef.modifyEffect(state, (current) =>
                Effect.succeed([
                  undefined,
                  current.active === registration.done
                    ? {
                        active: undefined,
                        queued: undefined,
                        acceptingFollowUp: false,
                      }
                    : current,
                ] as const),
              ).pipe(Effect.andThen(Deferred.done(registration.done, exit)), Effect.asVoid),
            ),
          ),
        );
      });

    return { run } as const;
  });
