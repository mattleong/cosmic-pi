import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
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
}

/**
 * Owns spawn-settlement → backend scope cleanup → token-confirmed lease release
 * ordering plus run-state reclamation and fail-closed cleanup quarantine for a
 * run record. Every field mutation stays under the shared service lock.
 */
export function makeRunRecordCleanup(dependencies: RunRecordCleanupDependencies) {
  const { withLock, publish, writerLeases } = dependencies;

  const prepareWriterLeaseForSpawn = (record: RunRecord): Effect.Effect<void, SubagentError> => {
    const canonicalCwd = record.canonicalWriterCwd;
    const leaseScope = record.writerLeaseScope;
    const releaseState = record.writerLeaseReleaseState;
    if (!canonicalCwd) return Effect.void;
    if (!leaseScope || !releaseState)
      return Effect.fail(
        new SubagentProcessError({
          operation: "prepare writer lease",
          code: "writer_lease_state_missing",
          message: `Subagent ${record.view.id} has no writer-lease preparation state.`,
        }),
      );
    const cancelled = () =>
      new InvalidSubagentRequestError({
        code: "start_cancelled",
        message: `Subagent ${record.view.id} lost writer-lease reservation ownership during startup.`,
      });
    return Effect.gen(function* () {
      const began = yield* withLock(
        Effect.sync(() => {
          if (
            record.writerLeaseScope !== leaseScope ||
            record.writerLeaseReleaseState !== releaseState ||
            record.writerLeasePreparationState !== "pending" ||
            record.stoppedByParent ||
            record.view.state === "stopping" ||
            record.view.state === "stopped"
          )
            return false;
          record.writerLeasePreparationState = "running";
          return true;
        }),
      );
      if (!began) return yield* cancelled();
      let handedOff = false;
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
          !handedOff || releaseState.authorized
            ? writerLeases.release(ownedLease).pipe(Effect.interruptible, Effect.orDie)
            : Effect.void,
      ).pipe(Effect.provideService(Scope.Scope, leaseScope));
      const attached = yield* withLock(
        Effect.sync(() => {
          if (
            record.writerLeaseScope !== leaseScope ||
            record.writerLeaseReleaseState !== releaseState
          )
            return "stale" as const;
          record.writerLease = lease;
          handedOff = true;
          return record.stoppedByParent || record.view.state === "stopping"
            ? ("cancelled" as const)
            : ("attached" as const);
        }),
      );
      if (attached === "stale") {
        releaseState.authorized = true;
        yield* Scope.close(leaseScope, Exit.void);
        return yield* cancelled();
      }
      if (attached === "cancelled") return yield* cancelled();

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
      const confirmed = yield* withLock(
        Effect.sync(() => {
          if (
            record.writerLeaseScope !== leaseScope ||
            record.writerLeaseReleaseState !== releaseState ||
            record.writerLease?.ownershipToken !== lease.ownershipToken ||
            record.stoppedByParent ||
            record.view.state === "stopping" ||
            record.view.state === "stopped"
          )
            return false;
          record.writerLease = marked;
          return true;
        }),
      );
      if (!confirmed) return yield* cancelled();
    }).pipe(
      Effect.ensuring(
        withLock(
          Effect.sync(() => {
            if (
              record.writerLeaseScope === leaseScope &&
              record.writerLeaseReleaseState === releaseState
            )
              record.writerLeasePreparationState = "settled";
          }),
        ),
      ),
    );
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
        Effect.timeoutOption("5 seconds"),
        Effect.flatMap((outcome) =>
          Option.isSome(outcome)
            ? Effect.void
            : Effect.fail(
                new SubagentProcessError({
                  operation: "reclaim private run state",
                  code: "run_state_reclaim_timeout",
                  message: "Timed out while reclaiming private subagent run state.",
                }),
              ),
        ),
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
        record.cleanupPending = true;
      }),
    );
  const clearCleanupPending = (record: RunRecord, scope: Scope.Closeable = record.scope) =>
    withLock(
      Effect.gen(function* () {
        if (record.scope !== scope) return false;
        record.cleanupPending = false;
        record.process = undefined;
        record.writerLease = undefined;
        record.writerLeaseScope = undefined;
        record.writerLeasePreparationState = undefined;
        record.writerLeaseReleaseState = undefined;
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
        return shouldReclaim;
      }),
    ).pipe(
      Effect.flatMap((shouldReclaim) =>
        shouldReclaim ? reclaimRecordRunState(record) : Effect.void,
      ),
    );
  const retainCleanupQuarantine = (record: RunRecord, scope: Scope.Closeable) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* withLock(
        Effect.gen(function* () {
          if (record.scope !== scope) return;
          const ownershipQuarantined =
            record.process !== undefined ||
            record.writerLease !== undefined ||
            record.writerLeaseScope !== undefined;
          const warning = ownershipQuarantined
            ? "Subagent cleanup could not be confirmed; process capacity and writer ownership remain quarantined for this session."
            : "Subagent cleanup could not be fully confirmed; this run remains quarantined for the session.";
          record.cleanupPending = true;
          record.warningSlots = setRunWarning(record.warningSlots, "system", warning);
          record.view = {
            ...record.view,
            warning,
            sessionEvents: appendNoticeSessionEvent(
              record.view.sessionEvents,
              "warning",
              warning,
              now,
            ),
          };
          yield* publish;
        }),
      );
    });
  const waitForWriterLeasePreparation = (
    record: RunRecord,
    scope: Scope.Closeable,
  ): Effect.Effect<void> =>
    Effect.suspend(() =>
      withLock(
        Effect.sync(
          () => record.scope === scope && record.writerLeasePreparationState === "running",
        ),
      ).pipe(
        Effect.flatMap((running) =>
          running
            ? Effect.sleep("25 millis").pipe(
                Effect.andThen(waitForWriterLeasePreparation(record, scope)),
              )
            : Effect.void,
        ),
      ),
    );
  const releaseWriterLeaseAfterCleanup = (record: RunRecord, scope: Scope.Closeable) =>
    waitForWriterLeasePreparation(record, scope).pipe(
      Effect.andThen(
        withLock(
          Effect.sync(() => {
            if (
              record.scope !== scope ||
              !record.writerLeaseScope ||
              !record.writerLeaseReleaseState
            )
              return undefined;
            if (record.writerLease) record.writerLeaseReleaseState.authorized = true;
            return record.writerLeaseScope;
          }),
        ),
      ),
      Effect.flatMap((leaseScope) =>
        leaseScope ? Scope.close(leaseScope, Exit.void) : Effect.void,
      ),
    );
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
          if (record.writerLeasePreparationState === "pending")
            record.writerLeasePreparationState = "settled";
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
        Effect.andThen(releaseWriterLeaseAfterCleanup(record, scope)),
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
    Effect.suspend(() =>
      withLock(
        Effect.sync(() =>
          record.scope !== scope || record.closingScope === scope
            ? "stale"
            : record.initializationPending
              ? "waiting"
              : "close",
        ),
      ).pipe(
        Effect.flatMap((ownership) =>
          ownership === "close"
            ? closeRecordScope(record, scope)
            : ownership === "waiting"
              ? Effect.sleep("25 millis").pipe(Effect.andThen(closeExitedScope(record, scope)))
              : Effect.void,
        ),
        Effect.asVoid,
      ),
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

export type RunRecordCleanup = ReturnType<typeof makeRunRecordCleanup>;
