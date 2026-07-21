import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SynchronizedRef from "effect/SynchronizedRef";

export interface AdvisorOwnedResource<A> {
  readonly value: A;
  readonly release: Effect.Effect<void>;
}

export interface AdvisorResourceState {
  readonly child: AdvisorOwnedResource<unknown> | undefined;
}

const flattenExit = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<A, E> =>
  Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause);

export interface AdvisorResourceStateService {
  readonly replaceChild: <A, E, R>(
    acquire: Effect.Effect<A, E, R>,
    release: (value: A) => Effect.Effect<void>,
  ) => Effect.Effect<A, E, R>;
  readonly stopChild: Effect.Effect<void>;
}

/** Effect-owned resource authority. Resource handles never enter AdvisorApplicationState. */
export const makeAdvisorResourceState = (): Effect.Effect<AdvisorResourceStateService> =>
  Effect.gen(function* () {
    const state = yield* SynchronizedRef.make<AdvisorResourceState>({ child: undefined });
    const stopChild = SynchronizedRef.modifyEffect(state, (current) =>
      current.child
        ? Effect.exit(current.child.release).pipe(
            Effect.map((released) => [released, { child: undefined }] as const),
          )
        : Effect.succeed([Exit.succeed(undefined), current] as const),
    ).pipe(Effect.flatMap(flattenExit));
    const replaceChild: AdvisorResourceStateService["replaceChild"] = (acquire, release) =>
      SynchronizedRef.modifyEffect(state, (current) =>
        Effect.gen(function* () {
          if (current.child) yield* Effect.exit(current.child.release);
          const acquired = yield* Effect.exit(acquire);
          return [
            acquired,
            Exit.isSuccess(acquired)
              ? { child: { value: acquired.value, release: release(acquired.value) } }
              : { child: undefined },
          ] as const;
        }),
      ).pipe(Effect.flatMap(flattenExit));
    return { replaceChild, stopChild };
  });
