import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { makeSynchronousIngress } from "pi-cosmic-core";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import type { SdkFetchOwner } from "./sdk-fetch.ts";
import { SdkHttpTraffic } from "./sdk-http-transport.ts";

const CONTROL_CAPACITY = 16;

interface ControlAdmission {
  readonly owner: SdkHttpTraffic;
  readonly deadline: bigint;
}

export class SdkHttpControlAdmissionError extends Schema.TaggedError<SdkHttpControlAdmissionError>()(
  "SdkHttpControlAdmissionError",
  {},
) {
  override readonly message = "MCP control traffic is unavailable.";
}

export interface SdkHttpControl {
  /** Synchronous SDK ingress. An admitted owner already holds its first fetch lease. */
  readonly begin: () => SdkFetchOwner;
  readonly close: Effect.Effect<void>;
}

/**
 * Notifications, replies, and other uncorrelated non-GET traffic have a bounded
 * lifetime independent of application cancellation and the session's GET stream.
 * The permit covers native cleanup, not just settlement of the SDK's consumer.
 */
export const makeSdkHttpControl = (options: {
  readonly lifetimeMs: number;
  readonly cleanupTimeoutMs: number;
  readonly onUnconfirmed: () => void;
}): Effect.Effect<SdkHttpControl, McpBoundaryError, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.fork(yield* Effect.scope);
    const clock = yield* Clock.Clock;
    const active = new Set<SdkHttpTraffic>();
    let open = true;

    const finish = (owner: SdkHttpTraffic) =>
      Effect.sync(owner.abort).pipe(
        Effect.andThen(
          owner
            .awaitIdle()
            .pipe(
              Effect.interruptible,
              Effect.timeoutOption(Duration.millis(options.cleanupTimeoutMs)),
            ),
        ),
        Effect.map((idle) => {
          if (Option.isSome(idle)) {
            active.delete(owner);
          } else {
            // Keep the unresolved owner and permanently close admission. A late
            // settlement may release its lease but cannot authorize reuse.
            open = false;
            options.onUnconfirmed();
          }
        }),
      );
    const ingress = yield* makeSynchronousIngress<ControlAdmission, never, never>({
      capacity: CONTROL_CAPACITY,
      overflow: "drop",
      handle: ({ owner, deadline }) =>
        Effect.suspend(() => {
          // Queue scheduling cannot extend a control's admission-time deadline.
          const remainingMs = Math.max(
            0,
            Number(deadline - clock.monotonicTimeNanosUnsafe()) / 1_000_000,
          );
          return owner.awaitIdle().pipe(
            Effect.timeoutOption(Duration.millis(remainingMs)),
            Effect.flatMap((idle) =>
              Option.isSome(idle)
                ? Effect.sync(() => {
                    active.delete(owner);
                  })
                : finish(owner),
            ),
          );
        }).pipe(
          Effect.forkIn(scope, { startImmediately: true, uninterruptible: false }),
          Effect.asVoid,
        ),
    }).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.mapError(() => boundaryError("connection", "not-sent", "Unable to own MCP controls.")),
    );

    const cachedClose = yield* Effect.cached(
      Effect.uninterruptible(
        Effect.sync(() => {
          open = false;
          for (const owner of active) owner.abort();
        }).pipe(
          // Stop all deadline fibers, then join even queued or cleanup-unconfirmed
          // owners. No foreign promise is awaited without a cleanup deadline.
          Effect.andThen(Scope.close(scope, Exit.void)),
          Effect.andThen(
            Effect.suspend(() =>
              Effect.forEach(active, finish, { concurrency: "unbounded", discard: true }),
            ),
          ),
        ),
      ),
    );
    const close = cachedClose.pipe(Effect.uninterruptible);
    yield* Effect.addFinalizer(() => close);

    return {
      close,
      begin: () => {
        if (!open || active.size >= CONTROL_CAPACITY) throw new SdkHttpControlAdmissionError();
        const owner = new SdkHttpTraffic();
        // Acquire before waking the watcher so it cannot mistake admission for idle.
        owner.fetchStarted();
        active.add(owner);
        const deadline = clock.monotonicTimeNanosUnsafe() + BigInt(options.lifetimeMs) * 1_000_000n;
        if (ingress.offer({ owner, deadline }) !== "accepted") {
          owner.abort();
          owner.fetchFinished();
          active.delete(owner);
          throw new SdkHttpControlAdmissionError();
        }
        return owner;
      },
    };
  });
