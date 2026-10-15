import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { processError } from "./errors.ts";
import type { RunContext, RunRecord } from "./internal.ts";
import type { WriterPools } from "./writer-pool.ts";
import { isTerminalRunState } from "./model.ts";
import { recordRunWarning } from "./warnings.ts";

type ExitedScopeOwnership = Data.TaggedEnum<{
  Stale: Record<never, never>;
  Close: Record<never, never>;
  Wait: { readonly settled: Deferred.Deferred<void> | undefined };
}>;
const ExitedScopeOwnership = Data.taggedEnum<ExitedScopeOwnership>();

export function recordCleanup(
  dependencies: Pick<RunContext, "withLock" | "publish"> & {
    readonly writerPools: Pick<WriterPools, "completeReleaseLocked">;
  },
) {
  const { withLock, publish, writerPools } = dependencies;

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
      if (reclaim)
        yield* reclaim({
          parentSessionId: record.launch.parentSessionId,
          runId: record.view.id,
        }).pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () =>
              Effect.fail(
                processError(
                  "reclaim private run state",
                  "run_state_reclaim_timeout",
                  "Timed out while reclaiming private subagent run state.",
                ),
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
      yield* withLock(
        Effect.gen(function* () {
          record.runStateReclaimState = "reclaimed";
          if (record.view.sessionFile === undefined) return;
          const { sessionFile: _reclaimed, ...view } = record.view;
          record.view = view;
          yield* publish;
        }),
      );
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
        if (record.scope !== scope) return { owned: false as const };
        const cleanupSettlement = record.cleanupSettlement;
        record.cleanupPending = false;
        record.process = undefined;
        const publishRelease =
          record.view.pid !== undefined || isTerminalRunState(record.view.state);
        if (record.view.pid !== undefined) {
          const { pid: _pid, ...view } = record.view;
          record.view = view;
        }
        if (publishRelease) yield* publish;
        return { owned: true as const, cleanupSettlement };
      }),
    ).pipe(
      Effect.flatMap((result) =>
        !result.owned
          ? Effect.void
          : withLock(
              Effect.sync(() => {
                if (record.scope !== scope) return;
                record.cleanupDisposition = "confirmed";
                Deferred.doneUnsafe(result.cleanupSettlement, Effect.succeed("confirmed"));
              }),
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
          record.writerPool?.quarantineLocked();
          const warning = ownershipQuarantined
            ? "Subagent cleanup could not be confirmed; process capacity and writer ownership remain quarantined for this session."
            : "Subagent cleanup could not be fully confirmed; this run remains quarantined for the session.";
          record.cleanupPending = true;
          record.cleanupDisposition = "quarantined";
          record.view = {
            ...record.view,
            retryBlocked:
              record.view.state === "failed" && (record.view.remainingCandidateCount ?? 0) > 0
                ? true
                : record.view.retryBlocked,
            ...recordRunWarning(record, record.view.sessionEvents, "system", warning, now),
            writeAdmissionPaused: record.writerPool ? true : record.view.writeAdmissionPaused,
          };
          yield* publish;
          return true;
        }),
      );
      if (retained) yield* Deferred.succeed(record.cleanupSettlement, "quarantined");
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
      if (preparation) yield* Deferred.await(preparation).pipe(Effect.ignore);
      const release = yield* withLock(
        Effect.sync(() => {
          if (record.scope !== scope || record.writerPool !== pool) return undefined;
          const releasing = pool.detachAfterCleanupLocked(record.view.id);
          if (!releasing) record.writerPool = undefined;
          return releasing;
        }),
      );
      if (!release) return;
      yield* Scope.close(release, Exit.void);
      yield* withLock(
        Effect.sync(() => {
          if (record.writerPool !== pool) return;
          if (writerPools.completeReleaseLocked(pool, record.view.id))
            record.writerPool = undefined;
        }),
      );
    });
  const closeRecordScope = (
    record: RunRecord,
    scope: Scope.Closeable = record.scope,
  ): Effect.Effect<void> => {
    const quarantine = (message: string) =>
      retainCleanupQuarantine(record, scope).pipe(
        Effect.andThen(
          Effect.logWarning(message).pipe(Effect.annotateLogs("runId", record.view.id)),
        ),
      );
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const closeSettled = yield* Deferred.make<void>();
        const claim = yield* withLock(
          Effect.sync(() => {
            if (record.scope !== scope) return { close: false as const, settled: undefined };
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
          if (!claim.settled) return;
          yield* restore(Deferred.await(claim.settled));
          const abandoned = yield* withLock(
            Effect.sync(
              () => record.scope === scope && record.closingScopeSettled !== claim.settled,
            ),
          );
          if (abandoned) yield* restore(closeRecordScope(record, scope));
          return;
        }
        if (claim.spawnSettled)
          yield* restore(Deferred.await(claim.spawnSettled)).pipe(
            Effect.onInterrupt(() =>
              withLock(
                Effect.sync(() => {
                  if (
                    record.closingScope === scope &&
                    record.closingScopeSettled === closeSettled
                  ) {
                    record.closingScope = undefined;
                    record.closingScopeSettled = undefined;
                  }
                  Deferred.doneUnsafe(closeSettled, Effect.void);
                }),
              ),
            ),
          );
        yield* Scope.close(scope, Exit.void).pipe(
          Effect.andThen(detachWriterPoolAfterCleanup(record, scope)),
          Effect.exit,
          Effect.flatMap((exit) =>
            Exit.isSuccess(exit)
              ? clearCleanupPending(record, scope)
              : quarantine("Subagent cleanup failed; the run remains quarantined."),
          ),
          Effect.onInterrupt(() => retainCleanupQuarantine(record, scope)),
          Effect.ensuring(Deferred.succeed(closeSettled, undefined)),
        );
      }),
    );
  };
  const closeExitedScope = (record: RunRecord, scope: Scope.Closeable): Effect.Effect<void> =>
    withLock(
      Effect.sync(() => {
        if (record.scope !== scope || record.closingScope === scope)
          return ExitedScopeOwnership.Stale();
        if (!record.initializationPending) return ExitedScopeOwnership.Close();
        return ExitedScopeOwnership.Wait({ settled: record.initializationSettled });
      }),
    ).pipe(
      Effect.flatMap(
        ExitedScopeOwnership.$match({
          Stale: () => Effect.void,
          Close: () => closeRecordScope(record, scope),
          Wait: ({ settled }) =>
            settled
              ? Deferred.await(settled).pipe(Effect.flatMap(() => closeExitedScope(record, scope)))
              : Effect.never,
        }),
      ),
      Effect.asVoid,
    );

  return {
    reclaimRecordRunState,
    markCleanupPending,
    retainCleanupQuarantine,
    closeRecordScope,
    closeExitedScope,
  };
}

export type RunRecordCleanup = ReturnType<typeof recordCleanup>;
