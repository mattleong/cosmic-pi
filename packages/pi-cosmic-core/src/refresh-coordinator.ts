import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import * as Semaphore from "effect/Semaphore";

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

const mergeRefreshRequest = (
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
    const lock = yield* Semaphore.make(1);
    const state = MutableRef.make<State<Request, E>>({
      active: undefined,
      queued: undefined,
      acceptingFollowUp: false,
    });

    const run = <R>(
      request: Request,
      operation: (request: Request) => Effect.Effect<void, E, R>,
    ): Effect.Effect<void, E, R> =>
      Effect.gen(function* () {
        const registration = yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const current = MutableRef.get(state);
            if (current.active) {
              if (current.acceptingFollowUp) {
                MutableRef.set(state, {
                  ...current,
                  queued: { value: merge(current.queued?.value, request) },
                });
              }
              return { owner: false as const, done: current.active };
            }
            const done = yield* Deferred.make<void, E>();
            MutableRef.set(state, { active: done, queued: undefined, acceptingFollowUp: true });
            return { owner: true as const, done };
          }),
        );
        if (!registration.owner) return yield* Deferred.await(registration.done);

        const work = Effect.gen(function* () {
          yield* operation(request);
          const followUp = yield* lock.withPermits(1)(
            Effect.sync(() => {
              const current = MutableRef.get(state);
              MutableRef.set(state, {
                ...current,
                queued: undefined,
                acceptingFollowUp: false,
              });
              return current.queued;
            }),
          );
          if (followUp !== undefined) yield* operation(followUp.value);
        });
        return yield* Effect.uninterruptibleMask((restore) =>
          restore(work).pipe(
            Effect.onExit((exit) =>
              lock
                .withPermits(1)(
                  Effect.sync(() => {
                    const current = MutableRef.get(state);
                    if (current.active === registration.done) {
                      MutableRef.set(state, {
                        active: undefined,
                        queued: undefined,
                        acceptingFollowUp: false,
                      });
                    }
                  }),
                )
                .pipe(Effect.andThen(Deferred.done(registration.done, exit)), Effect.asVoid),
            ),
          ),
        );
      });

    return { run } as const;
  });

/** Provider refresh specialization retained for existing packages. */
export const makeRefreshCoordinator = <E = never>() =>
  makeRefreshCoordinatorWith<RefreshRequest, E>(mergeRefreshRequest);

export type RefreshCoordinator<E = never> = Effect.Success<
  ReturnType<typeof makeRefreshCoordinator<E>>
>;
