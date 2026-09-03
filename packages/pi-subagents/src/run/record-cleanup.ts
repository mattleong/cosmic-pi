import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { WriterLeaseConflictError, WriterLeaseContract } from "../boundary/writer-lease.ts";
import {
  InvalidSubagentRequestError,
  type SubagentError,
  SubagentProcessError,
  SubagentWriterConflictError,
} from "./errors.ts";
import type { RunRecord } from "./internal.ts";
import { appendNoticeSessionEvent } from "./session-events.ts";
import { setRunWarning } from "./warnings.ts";
import type { WriterPoolEntry } from "./writer-pool.ts";

const mapWriterLeaseConflict = (error: WriterLeaseConflictError): SubagentWriterConflictError =>
  new SubagentWriterConflictError({
    activeId: error.ownerRunId ?? "unknown-cross-process-writer",
    activeName: "cross-process writer",
    message: error.message,
  });

export interface RunRecordCleanupDependencies {
  /** The shared service lock guarding every RunRecord mutation. */
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly publish: Effect.Effect<void>;
  readonly writerLeases: WriterLeaseContract;
  readonly writerPools: Map<string, WriterPoolEntry>;
}

/**
 * Owns spawn-settlement → backend scope cleanup → token-confirmed lease release
 * ordering plus run-state reclamation and fail-closed cleanup quarantine for a
 * run record. Every field mutation stays under the shared service lock.
 */
export function makeRunRecordCleanup(dependencies: RunRecordCleanupDependencies) {
  const { withLock, publish, writerLeases, writerPools } = dependencies;

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
    return Effect.gen(function* () {
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
        yield* Deferred.await(pool.preparationSettled);
        const attached = yield* withLock(
          Effect.sync(
            () =>
              record.writerPool === pool &&
              pool.members.has(record.view.id) &&
              !record.stoppedByParent,
          ),
        );
        if (!attached) return yield* cancelled();
        return;
      }
      if (role.kind === "ready") return;

      let handedOff = false;
      let preparationError: SubagentError | undefined;
      const prepareOwner = Effect.gen(function* () {
        const lease = yield* Effect.acquireRelease(
          writerLeases
            .acquire({
              cwd: canonicalCwd,
              sessionId: record.launch.parentSessionId,
              runId: record.view.id,
            })
            .pipe(
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
              ? writerLeases.release(ownedLease).pipe(Effect.interruptible, Effect.orDie)
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
        const ownerStillAttached = yield* withLock(
          Effect.sync(
            () =>
              record.writerPool === pool &&
              pool.members.has(record.view.id) &&
              !record.stoppedByParent,
          ),
        );
        if (!ownerStillAttached) return yield* cancelled();
      }).pipe(
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
      yield* prepareOwner;
    });
  };
  const reclaimRecordRunState = (record: RunRecord) =>
    Effect.gen(function* () {
      const claimed = yield* withLock(
        Effect.sync(() => {
          if (record.runStateReclaimState !== "pending") return false;
          record.runStateReclaimState = "running";
          return true;
        }),
      );
      if (!claimed) return;
      const reclaim = record.driver.reclaimRunState;
      if (!reclaim) {
        yield* withLock(Effect.sync(() => void (record.runStateReclaimState = "reclaimed")));
        return;
      }
      yield* reclaim({
        parentSessionId: record.launch.parentSessionId,
        runId: record.view.id,
      }).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () =>
            Effect.fail(
              new SubagentProcessError({
                operation: "reclaim private run state",
                code: "run_state_reclaim_timeout",
                message: "Timed out while reclaiming private subagent run state.",
              }),
            ),
        }),
        Effect.tapError((error) =>
          withLock(
            Effect.sync(() => {
              record.runStateReclaimState = "pending";
            }),
          ).pipe(
            Effect.andThen(
              Effect.logWarning(`Could not reclaim private subagent run state: ${error.message}`),
            ),
          ),
        ),
        Effect.annotateLogs("runId", record.view.id),
      );
      yield* withLock(Effect.sync(() => void (record.runStateReclaimState = "reclaimed")));
    });
  const markCleanupPending = (record: RunRecord) =>
    withLock(
      Effect.sync(() => {
        if (record.closingScope === record.scope && record.cleanupDisposition !== "pending") return;
        record.cleanupPending = true;
        record.cleanupDisposition = "pending";
      }),
    );
  const clearCleanupPending = (record: RunRecord, scope: Scope.Closeable = record.scope) =>
    withLock(
      Effect.gen(function* () {
        if (record.scope !== scope) return { owned: false as const, shouldReclaim: false };
        const cleanupSettlement = record.cleanupSettlement;
        record.cleanupPending = false;
        record.process = undefined;
        const shouldReclaim =
          record.stoppedByParent ||
          record.view.state === "failed" ||
          record.view.state === "stopped" ||
          record.view.state === "stopping";
        if (record.view.pid !== undefined) {
          const { pid: _pid, ...view } = record.view;
          record.view = view;
          yield* publish;
        }
        return { owned: true as const, shouldReclaim, cleanupSettlement };
      }),
    ).pipe(
      Effect.flatMap((result) =>
        !result.owned
          ? Effect.void
          : (result.shouldReclaim ? reclaimRecordRunState(record) : Effect.void).pipe(
              Effect.tap(() =>
                withLock(
                  Effect.sync(() => {
                    if (record.scope !== scope) return;
                    record.cleanupDisposition = "confirmed";
                    Deferred.doneUnsafe(result.cleanupSettlement, Effect.succeed("confirmed"));
                  }),
                ),
              ),
            ),
      ),
    );
  const retainCleanupQuarantine = (record: RunRecord, scope: Scope.Closeable) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const retained = yield* withLock(
        Effect.gen(function* () {
          if (record.scope !== scope) return false;
          const ownershipQuarantined =
            record.process !== undefined || record.writerPool !== undefined;
          if (record.writerPool) {
            record.writerPool.state = "quarantined";
            record.writerPool.admissionPaused = true;
            record.writerPool.pauseReason =
              "A writer process or lease cleanup could not be confirmed.";
          }
          const warning = ownershipQuarantined
            ? "Subagent cleanup could not be confirmed; process capacity and writer ownership remain quarantined for this session."
            : "Subagent cleanup could not be fully confirmed; this run remains quarantined for the session.";
          record.cleanupPending = true;
          record.cleanupDisposition = "quarantined";
          record.warningSlots = setRunWarning(record.warningSlots, "system", warning);
          record.view = {
            ...record.view,
            retryBlocked:
              record.view.state === "failed" && (record.view.remainingCandidateCount ?? 0) > 0
                ? true
                : record.view.retryBlocked,
            warning,
            writeAdmissionPaused: record.writerPool ? true : record.view.writeAdmissionPaused,
            sessionEvents: appendNoticeSessionEvent(
              record.view.sessionEvents,
              "warning",
              warning,
              now,
            ),
          };
          yield* publish;
          return true;
        }),
      );
      if (retained)
        yield* Effect.sync(() => {
          Deferred.doneUnsafe(record.cleanupSettlement, Effect.succeed("quarantined"));
        });
    });
  const detachWriterPoolAfterCleanup = (record: RunRecord, scope: Scope.Closeable) =>
    Effect.gen(function* () {
      const pool = record.writerPool;
      if (!pool) return;
      const preparation = yield* withLock(
        Effect.sync(() =>
          record.scope === scope && pool.state === "preparing"
            ? pool.preparationSettled
            : undefined,
        ),
      );
      if (preparation) yield* Deferred.await(preparation).pipe(Effect.catch(() => Effect.void));
      const release = yield* withLock(
        Effect.sync(() => {
          if (record.scope !== scope || record.writerPool !== pool) return undefined;
          if (!pool.members.has(record.view.id)) {
            record.writerPool = undefined;
            return undefined;
          }
          if (pool.members.size > 1) {
            pool.members.delete(record.view.id);
            record.writerPool = undefined;
            return undefined;
          }
          pool.state = "releasing";
          if (pool.lease) pool.releaseState.authorized = true;
          return pool.leaseScope;
        }),
      );
      if (!release) return;
      yield* Scope.close(release, Exit.void);
      yield* withLock(
        Effect.sync(() => {
          if (record.writerPool !== pool || pool.state !== "releasing") return;
          pool.members.delete(record.view.id);
          record.writerPool = undefined;
          pool.lease = undefined;
          if (pool.admissionPaused) {
            pool.state = "paused";
            return;
          }
          if (writerPools.get(pool.cwd.digest) === pool) writerPools.delete(pool.cwd.digest);
        }),
      );
    });
  const closeRecordScope = (record: RunRecord, scope: Scope.Closeable = record.scope) =>
    Effect.gen(function* () {
      const closeSettled = yield* Deferred.make<void>();
      const claim = yield* withLock(
        Effect.sync(() => {
          if (record.closingScope === scope)
            return {
              close: false as const,
              settled: record.closingScopeSettled,
            };
          record.closingScope = scope;
          record.closingScopeSettled = closeSettled;
          return {
            close: true as const,
            settled: closeSettled,
            spawnSettled:
              record.backendSpawnAttempt?.scope === scope
                ? record.backendSpawnAttempt.settled
                : undefined,
          };
        }),
      );
      if (!claim.close) {
        if (claim.settled) yield* Deferred.await(claim.settled);
        return;
      }
      yield* (claim.spawnSettled ? Deferred.await(claim.spawnSettled) : Effect.void).pipe(
        Effect.andThen(Scope.close(scope, Exit.void)),
        Effect.andThen(detachWriterPoolAfterCleanup(record, scope)),
        Effect.exit,
        Effect.flatMap((exit) =>
          Exit.isSuccess(exit)
            ? clearCleanupPending(record, scope)
            : retainCleanupQuarantine(record, scope).pipe(
                Effect.andThen(
                  Effect.logWarning("Subagent cleanup failed; the run remains quarantined.").pipe(
                    Effect.annotateLogs("runId", record.view.id),
                  ),
                ),
              ),
        ),
        Effect.catch((error) =>
          retainCleanupQuarantine(record, scope).pipe(
            Effect.andThen(
              Effect.logWarning(`Subagent cleanup failed: ${error.message}`).pipe(
                Effect.annotateLogs("runId", record.view.id),
              ),
            ),
          ),
        ),
        Effect.onInterrupt(() => retainCleanupQuarantine(record, scope)),
        Effect.ensuring(Effect.sync(() => Deferred.doneUnsafe(closeSettled, Effect.void))),
      );
    });
  const closeExitedScope = (record: RunRecord, scope: Scope.Closeable): Effect.Effect<void> =>
    withLock(
      Effect.sync(() => {
        if (record.scope !== scope || record.closingScope === scope)
          return { _tag: "Stale" } as const;
        if (!record.initializationPending) return { _tag: "Close" } as const;
        return { _tag: "Wait", settled: record.initializationSettled } as const;
      }),
    ).pipe(
      Effect.flatMap((ownership) => {
        if (ownership._tag === "Stale") return Effect.void;
        if (ownership._tag === "Close") return closeRecordScope(record, scope);
        return ownership.settled
          ? Deferred.await(ownership.settled).pipe(
              Effect.flatMap(() => closeExitedScope(record, scope)),
            )
          : Effect.never;
      }),
      Effect.asVoid,
    );

  return {
    /** Durably prepares and token-confirms the writer lease before any driver spawn. */
    prepareWriterLeaseForSpawn,
    /** Exclusive pending→running→reclaimed private run-state reclamation; failure re-arms. */
    reclaimRecordRunState,
    markCleanupPending,
    /** Fail-closed quarantine retaining process capacity and writer ownership for the session. */
    retainCleanupQuarantine,
    /** Spawn settlement → scope close → lease release → clear/quarantine, exactly once per scope. */
    closeRecordScope,
    /** Defers scope closure while initialization still owns the record. */
    closeExitedScope,
  };
}
