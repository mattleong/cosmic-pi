import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { flow } from "effect/Function";
import * as Schema from "effect/Schema";
import { acquireNativeLock, type NativeLockOptions } from "./cross-process-lock-node.ts";

export class CrossProcessLockError extends Schema.TaggedError<CrossProcessLockError>()(
  "CrossProcessLockError",
  { reason: Schema.Literals(["unavailable", "recovery-required"]) },
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
}
const failure = flow(
  Schema.decodeUnknownOption(CrossProcessLockError),
  Option.getOrElse(() => new CrossProcessLockError({ reason: "unavailable" })),
);

/** Opt-in same-host coordination. No stale-time or heartbeat stealing. */
export class CrossProcessLock extends Context.Service<CrossProcessLock, CrossProcessLockContract>()(
  "pi-cosmic-core/platform/cross-process-lock/CrossProcessLock",
) {
  static readonly layer = (options: NativeLockOptions = {}) =>
    Layer.succeed(this, {
      withLock: (namespace, use, check = Effect.void) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            for (;;) {
              yield* restore(check);
              const lease = yield* Effect.try({
                try: () => acquireNativeLock(namespace, options),
                catch: failure,
              });
              if (lease)
                return yield* restore(Effect.andThen(check, use(lease))).pipe(
                  Effect.onExit(() => Effect.try({ try: lease.release, catch: failure })),
                );
              yield* restore(Effect.sleep(options.pollMs ?? 50));
            }
          }),
        ),
    });
}
export type { NativeLockOptions as CrossProcessLockOptions } from "./cross-process-lock-node.ts";
