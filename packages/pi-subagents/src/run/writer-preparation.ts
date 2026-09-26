import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import type { WriterLeaseConflictError } from "../boundary/writer-lease.ts";
import {
  InvalidSubagentRequestError,
  type SubagentError,
  SubagentProcessError,
  SubagentWriterConflictError,
} from "./errors.ts";
import type { RunContext, RunRecord } from "./internal.ts";

/** Core lock evidence never names another session's run, so the owner stays anonymous. */
const mapWriterLeaseConflict = ({ message }: WriterLeaseConflictError) =>
  new SubagentWriterConflictError({
    activeId: "unknown-cross-process-writer",
    activeName: "cross-process writer",
    message,
  });

/**
 * Durably prepares and token-confirms the writer lease before any driver spawn. Claims
 * preparation and installs settlement cleanup before restoring interruption.
 */
export function makeWriterPreparation({ withLock, writerLeases }: RunContext) {
  const prepareWriterLeaseForSpawn = (record: RunRecord): Effect.Effect<void, SubagentError> => {
    const canonicalCwd = record.canonicalWriterCwd;
    const pool = record.writerPool;
    if (!canonicalCwd) return Effect.void;
    if (!pool)
      return Effect.fail(
        new SubagentProcessError({
          operation: "prepare writer lease",
          code: "writer_pool_state_missing",
          message: `Subagent ${record.view.id} has no writer-pool preparation state.`,
        }),
      );
    const cancelled = () =>
      new InvalidSubagentRequestError({
        code: "start_cancelled",
        message: `Subagent ${record.view.id} lost writer-pool membership during startup.`,
      });
    const stillAttached = withLock(
      Effect.sync(
        () =>
          record.writerPool === pool && pool.members.has(record.view.id) && !record.stoppedByParent,
      ),
    );
    // The preparing state owns the shared latch. Keep that claim masked until
    // ensuring is installed, even if the lock yields while returning ownership.
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const role = yield* withLock(
          Effect.sync(() => {
            if (
              record.writerPool !== pool ||
              !pool.members.has(record.view.id) ||
              record.stoppedByParent ||
              record.view.state === "stopping" ||
              record.view.state === "stopped"
            )
              return { kind: "cancelled" as const };
            switch (pool.state) {
              case "pending":
                pool.state = "preparing";
                return { kind: "owner" as const };
              case "preparing":
                return { kind: "wait" as const };
              case "held":
                return { kind: "ready" as const };
              case "failed":
                return { kind: "failed" as const, error: pool.preparationError ?? cancelled() };
              case "releasing":
              case "paused":
              case "quarantined":
                return { kind: "cancelled" as const };
            }
          }),
        );
        if (role.kind === "cancelled") return yield* cancelled();
        if (role.kind === "failed") return yield* role.error;
        if (role.kind === "wait") {
          yield* restore(Deferred.await(pool.preparationSettled));
          if (!(yield* restore(stillAttached))) return yield* cancelled();
          return;
        }
        if (role.kind === "ready") return;

        let handedOff = false;
        let preparationError: SubagentError | undefined;
        const prepareOwner = Effect.gen(function* () {
          // acquireRelease masks the lease handoff to its finalizer; acquire keeps
          // only its pre-ownership checks interruptible.
          const lease = yield* Effect.acquireRelease(
            writerLeases.acquire({ cwd: canonicalCwd, runId: record.view.id }).pipe(
              Effect.mapError((error) =>
                error._tag === "WriterLeaseConflictError"
                  ? mapWriterLeaseConflict(error)
                  : new SubagentProcessError({
                      operation: "acquire writer lease",
                      code: "writer_lease_acquire_failed",
                      message: error.message,
                    }),
              ),
            ),
            (ownedLease) =>
              !handedOff || pool.releaseState.authorized
                ? writerLeases.release(ownedLease).pipe(Effect.orDie)
                : Effect.void,
          ).pipe(Effect.provideService(Scope.Scope, pool.leaseScope));
          const attached = yield* withLock(
            Effect.sync(() => {
              if (record.writerPool !== pool || pool.state !== "preparing") return false;
              pool.lease = lease;
              handedOff = true;
              return true;
            }),
          );
          if (!attached) return yield* cancelled();
          const marked = yield* writerLeases.markSpawnStarted(lease).pipe(
            Effect.mapError(
              (error) =>
                new SubagentProcessError({
                  operation: "mark writer spawn started",
                  code: "writer_lease_mark_failed",
                  message: error.message,
                }),
            ),
          );
          yield* withLock(
            Effect.sync(() => {
              if (pool.state !== "preparing") return;
              pool.lease = marked;
              pool.state = "held";
              Deferred.doneUnsafe(pool.preparationSettled, Effect.void);
            }),
          );
          if (!(yield* stillAttached)) return yield* cancelled();
        });
        yield* restore(prepareOwner).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              preparationError = error;
            }),
          ),
          Effect.ensuring(
            withLock(
              Effect.sync(() => {
                if (pool.state !== "preparing") return;
                const error = preparationError ?? cancelled();
                pool.state = "failed";
                pool.preparationError = error;
                Deferred.doneUnsafe(pool.preparationSettled, Effect.fail(error));
              }),
            ),
          ),
        );
      }),
    );
  };
  return prepareWriterLeaseForSpawn;
}

export type WriterPreparation = ReturnType<typeof makeWriterPreparation>;
