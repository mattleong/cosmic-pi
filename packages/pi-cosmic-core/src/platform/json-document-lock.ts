import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  acquireLockOffThread,
  CrossProcessLockError,
  ownerIsDead,
  type CrossProcessLockOwner,
  type OffThreadLease,
} from "./cross-process-lock.ts";
import { nodePath as path } from "./node-builtins.ts";

const INITIAL_RETRY_MILLIS = 5;
const MAX_RETRY_MILLIS = 100;
/** How long a waiter trusts its last finding that the current owner is not dead. */
const OWNER_RECHECK_MILLIS = 1_000;

export class JsonDocumentLockError extends Schema.TaggedError<
  JsonDocumentLockError,
  { readonly brand: unique symbol }
>()("JsonDocumentLockError", {
  reason: Schema.Literals(["busy", "unavailable", "recovery-required"]),
  slot: Schema.optionalKey(Schema.String),
}) {}

export interface JsonDocumentLockContract {
  /** Runs `effect` while this process exclusively owns the canonical document path. */
  readonly withLock: <A, E, R>(
    documentPath: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | JsonDocumentLockError, R>;
}

export interface JsonDocumentLockOptions {
  /** How long a writer waits for another process before failing as busy. */
  readonly timeout: Duration.Input;
}

/**
 * The private lock root beside the document, named so it never collides with Pi's own
 * proper-lockfile `<file>.lock` directories. It stays after release: removing it would race
 * writers that are creating their owner records inside it.
 */
const jsonDocumentLockDirectory = (documentPath: string): string =>
  path.join(path.dirname(documentPath), `.${path.basename(documentPath)}.lock`);

const isCrossProcessLockError = Schema.is(CrossProcessLockError);

const lockError = (cause: unknown): JsonDocumentLockError =>
  isCrossProcessLockError(cause) && cause.reason === "recovery-required"
    ? JsonDocumentLockError.make({
        reason: "recovery-required",
        ...(cause.slot !== undefined && { slot: cause.slot }),
      })
    : JsonDocumentLockError.make({ reason: "unavailable" });

// An unconfirmed release leaves the slot held until this process exits; writers then reclaim it.
const releaseLease = (lease: OffThreadLease) => Effect.ignore(lease.release);

interface CheckedOwner {
  readonly token: string;
  readonly checkedAt: number;
}

const makeNodeJsonDocumentLock = (options: JsonDocumentLockOptions): JsonDocumentLockContract => {
  const timeoutMillis = Duration.toMillis(options.timeout);
  const acquire = Effect.fnUntraced(function* (
    documentPath: string,
    directory: string,
    restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  ) {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMillis;
    let delay = INITIAL_RETRY_MILLIS;
    // Probing liveness can spawn `ps` synchronously, so retries against the same owner reuse a
    // recent finding. Treating that owner as live only delays recovery, which already fails closed.
    let notDead: CheckedOwner | undefined;
    for (;;) {
      const now = yield* Clock.currentTimeMillis;
      const isDead = (owner: CrossProcessLockOwner): boolean => {
        if (notDead?.token === owner.token && now - notDead.checkedAt < OWNER_RECHECK_MILLIS)
          return false;
        if (ownerIsDead(owner)) return true;
        notDead = { token: owner.token, checkedAt: now };
        return false;
      };
      const lease = yield* acquireLockOffThread(documentPath, { directory }, isDead).pipe(
        Effect.mapError(lockError),
      );
      if (lease !== undefined) return lease;
      if ((yield* Clock.currentTimeMillis) >= deadline)
        return yield* JsonDocumentLockError.make({ reason: "busy" });
      yield* restore(Effect.sleep(delay));
      delay = Math.min(delay * 2, MAX_RETRY_MILLIS);
    }
  });
  return {
    withLock: (documentPath, effect) => {
      const directory = jsonDocumentLockDirectory(documentPath);
      return Effect.uninterruptibleMask((restore) =>
        acquire(documentPath, directory, restore).pipe(
          Effect.flatMap((lease) => restore(effect).pipe(Effect.ensuring(releaseLease(lease)))),
        ),
      );
    },
  };
};

/**
 * Same-host exclusion for read-modify-write of one JSON document across Pi processes. Owners
 * record their PID and start time, so a crashed writer's lock is reclaimed by the next writer.
 */
export class JsonDocumentLock extends Context.Service<JsonDocumentLock, JsonDocumentLockContract>()(
  "pi-cosmic-core/platform/json-document-lock/JsonDocumentLock",
) {
  static readonly layerWith = (options: JsonDocumentLockOptions): Layer.Layer<JsonDocumentLock> =>
    Layer.succeed(this, makeNodeJsonDocumentLock(options));

  static readonly layer: Layer.Layer<JsonDocumentLock> = this.layerWith({ timeout: "5 seconds" });
}
