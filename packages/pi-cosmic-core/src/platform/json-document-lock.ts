import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  acquireNativeLock,
  CrossProcessLockError,
  type CrossProcessLease,
} from "./cross-process-lock.ts";
import { nodePath as path } from "./node-builtins.ts";

const INITIAL_RETRY_MILLIS = 5;
const MAX_RETRY_MILLIS = 100;

export class JsonDocumentLockError extends Schema.TaggedError<JsonDocumentLockError>()(
  "JsonDocumentLockError",
  {
    reason: Schema.Literals(["busy", "unavailable", "recovery-required"]),
    slot: Schema.optionalKey(Schema.String),
  },
) {}

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

const lockError = (cause: unknown): JsonDocumentLockError =>
  cause instanceof CrossProcessLockError && cause.reason === "recovery-required"
    ? new JsonDocumentLockError({
        reason: "recovery-required",
        ...(cause.slot !== undefined && { slot: cause.slot }),
      })
    : new JsonDocumentLockError({ reason: "unavailable" });

const releaseLease = (lease: CrossProcessLease) =>
  Effect.sync(() => {
    try {
      lease.release();
    } catch {
      // An unconfirmed release leaves the slot held until this process exits; writers then reclaim it.
    }
  });

const makeNodeJsonDocumentLock = (options: JsonDocumentLockOptions): JsonDocumentLockContract => {
  const timeoutMillis = Duration.toMillis(options.timeout);
  const tryAcquire = (documentPath: string, directory: string) =>
    Effect.try({
      try: () => acquireNativeLock(documentPath, { directory }, true),
      catch: lockError,
    });
  const acquire = Effect.fnUntraced(function* (
    documentPath: string,
    directory: string,
    restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  ) {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMillis;
    let delay = INITIAL_RETRY_MILLIS;
    for (;;) {
      const lease = yield* tryAcquire(documentPath, directory);
      if (lease !== undefined) return lease;
      if ((yield* Clock.currentTimeMillis) >= deadline)
        return yield* new JsonDocumentLockError({ reason: "busy" });
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
