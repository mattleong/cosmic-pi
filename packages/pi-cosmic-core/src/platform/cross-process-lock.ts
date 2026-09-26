import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Semaphore from "effect/Semaphore";
import { acquireNativeLock, type NativeLockOptions } from "./cross-process-lock-node.ts";

export class CrossProcessLockError extends Schema.TaggedError<CrossProcessLockError>()(
  "CrossProcessLockError",
  { reason: Schema.Literals(["unavailable", "recovery-required", "acquire-timeout"]) },
) {}

/** Native completion callbacks are capabilities of this exact owner, not lock paths. */
export interface CrossProcessLease {
  /** Persist before entering an irreversible native operation. Throws on lost ownership. */
  readonly mutationStarted: () => void;
  /** Invoke only once the actual native Promise settles, never on abort/timeout. */
  readonly mutationSettled: () => void;
  /** Retains pending mutation evidence; late settlement releases this exact owner. */
  readonly release: () => void;
}
export interface CrossProcessLockContract {
  readonly withLock: <A, E, R>(
    namespace: string,
    use: (lease: CrossProcessLease) => Effect.Effect<A, E, R>,
    check?: Effect.Effect<void, E, R>,
  ) => Effect.Effect<A, E | CrossProcessLockError, R>;
  /**
   * One synchronous admission attempt with no polling. A dead quiescent owner is retired and
   * retried once, so `undefined` means a live owner holds the slot. The caller owns release.
   */
  readonly tryAcquire: (
    namespace: string,
  ) => Effect.Effect<CrossProcessLease | undefined, CrossProcessLockError>;
}
const failure = (cause: unknown) =>
  cause instanceof CrossProcessLockError
    ? cause
    : new CrossProcessLockError({ reason: "unavailable" });
const AdmissionDeadline = Context.Reference<bigint | undefined>(
  "pi-cosmic-core/platform/cross-process-lock/AdmissionDeadline",
  { defaultValue: () => undefined },
);
const timedOut = () => new CrossProcessLockError({ reason: "acquire-timeout" });
const invalidMillis = (ms: number) => !Number.isFinite(ms) || ms <= 0 || ms > 2_147_483_647;
const permitChanges = new WeakMap<Semaphore.Semaphore, { pulse: Deferred.Deferred<void> }>();

/** Polling avoids a timeout race transferring an acquired permit from a losing child fiber. */
const withAdmission = <L, A, E, R>(
  acquire: Effect.Effect<L | undefined, CrossProcessLockError>,
  release: (lease: L) => Effect.Effect<unknown, CrossProcessLockError>,
  use: (lease: L) => Effect.Effect<A, E, R>,
  check: Effect.Effect<void, E, R>,
  options: NativeLockOptions,
  changed: Effect.Effect<void> = Effect.never,
): Effect.Effect<A, E | CrossProcessLockError, R> =>
  Effect.gen(function* () {
    const timeout = options.acquireTimeoutMs ?? 15_000;
    const poll = options.pollMs ?? 50;
    if (invalidMillis(timeout) || invalidMillis(poll))
      return yield* new CrossProcessLockError({ reason: "unavailable" });
    const now = yield* Clock.monotonicTimeNanos;
    const inherited = yield* AdmissionDeadline;
    const local = now + BigInt(Math.ceil(timeout * 1_000_000));
    const deadline = inherited === undefined || local < inherited ? local : inherited;
    const remaining = Effect.gen(function* () {
      const left = Number(deadline - (yield* Clock.monotonicTimeNanos)) / 1_000_000;
      if (left <= 0) return yield* timedOut();
      return left;
    });
    const timedCheck = Effect.gen(function* () {
      const left = yield* remaining;
      yield* check.pipe(
        Effect.timeoutOrElse({ duration: left, orElse: () => Effect.fail(timedOut()) }),
      );
      yield* remaining;
    });
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        for (;;) {
          yield* restore(timedCheck);
          const lease = yield* acquire;
          // Install exact-owner release while masked, before the timed check can fail.
          // Only admission checks have a deadline; admitted work has no timer.
          if (lease !== undefined)
            return yield* restore(
              timedCheck.pipe(Effect.andThen(Effect.suspend(() => use(lease)))),
            ).pipe(Effect.onExit(() => release(lease)));
          yield* restore(Effect.raceFirst(Effect.sleep(Math.min(poll, yield* remaining)), changed));
        }
      }),
    ).pipe(Effect.provideService(AdmissionDeadline, deadline));
  });

/** Opt-in same-host coordination. No stale-time or heartbeat stealing. */
export class CrossProcessLock extends Context.Service<CrossProcessLock, CrossProcessLockContract>()(
  "pi-cosmic-core/platform/cross-process-lock/CrossProcessLock",
) {
  /** Bound an upstream local permit with the same budget as nested filesystem admission. */
  static readonly withPermit = <A, E, R>(
    permit: Semaphore.Semaphore,
    work: Effect.Effect<A, E, R>,
    check: Effect.Effect<void, E, R> = Effect.void,
    options: NativeLockOptions = {},
  ) =>
    Effect.suspend(() => {
      let state = permitChanges.get(permit);
      if (!state) {
        state = { pulse: Deferred.makeUnsafe<void>() };
        permitChanges.set(permit, state);
      }
      const changes = state;
      let observed = changes.pulse;
      return withAdmission(
        Effect.suspend(() => {
          observed = changes.pulse;
          return permit.takeIfAvailable(1).pipe(Effect.map((taken) => (taken ? true : undefined)));
        }),
        () =>
          permit.release(1).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                const previous = changes.pulse;
                changes.pulse = Deferred.makeUnsafe<void>();
                Deferred.doneUnsafe(previous, Effect.void);
              }),
            ),
          ),
        () => work,
        check,
        options,
        Effect.suspend(() => Deferred.await(observed)),
      );
    });

  static readonly layer = (options: NativeLockOptions = {}) =>
    Layer.succeed(this, {
      withLock: (namespace, use, check = Effect.void) =>
        withAdmission(
          Effect.try({ try: () => acquireNativeLock(namespace, options), catch: failure }),
          (lease) => Effect.try({ try: lease.release, catch: failure }),
          use,
          check,
          options,
        ),
      tryAcquire: (namespace) =>
        Effect.try({ try: () => acquireNativeLock(namespace, options, true), catch: failure }),
    });
}
export type { NativeLockOptions as CrossProcessLockOptions } from "./cross-process-lock-node.ts";
