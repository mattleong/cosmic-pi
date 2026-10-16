import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { processError } from "./errors.ts";
import type { RunContext, RunRecord } from "./internal.ts";
import type { WriterPools } from "./writer-pool.ts";
import type { BackendHandle } from "../backend/model.ts";
import type { SubagentCleanupDiagnostic } from "./model.ts";
import {
  boundedCleanupDiagnostic,
  cleanupFailureDiagnostic as failureDiagnostic,
} from "./cleanup-diagnostic.ts";

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
                Effect.logWarning(
                  `Could not reclaim private subagent run state: ${failureDiagnostic("backend-scope", Cause.fail(error)).message}`,
                ),
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
      Effect.gen(function* () {
        if (record.closingScope === record.scope && record.cleanupDisposition !== "pending") return;
        record.cleanupPending = true;
        record.cleanupDisposition = "pending";
        record.view = { ...record.view, cleanup: { disposition: "pending" } };
        yield* publish;
      }),
    );

  const clearCleanupPending = (record: RunRecord, scope: Scope.Closeable = record.scope) =>
    withLock(
      Effect.gen(function* () {
        if (record.scope !== scope) return;
        record.cleanupPending = false;
        record.cleanupDisposition = "confirmed";
        record.cleanupRecovery = undefined;
        record.process = undefined;
        const { pid: _pid, ...view } = record.view;
        record.view = { ...view, cleanup: { disposition: "confirmed" } };
        yield* publish;
        Deferred.doneUnsafe(record.cleanupSettlement, Effect.succeed("confirmed"));
      }),
    );

  const retainCleanupQuarantine = (
    record: RunRecord,
    scope: Scope.Closeable,
    diagnostic: SubagentCleanupDiagnostic = {
      phase: "backend-scope",
      message: "Backend cleanup did not provide confirmation.",
    },
    recoverableProcess?: BackendHandle,
  ) =>
    withLock(
      Effect.gen(function* () {
        if (record.scope !== scope) return;
        record.writerPool?.quarantineLocked(record.view.id, diagnostic.phase === "writer-lease");
        record.cleanupPending = true;
        record.cleanupDisposition = "quarantined";
        record.cleanupRecovery = recoverableProcess
          ? { scope, process: recoverableProcess }
          : undefined;
        record.view = {
          ...record.view,
          cleanup: {
            disposition: "quarantined",
            recovery: recoverableProcess ? "stop" : "manual",
            diagnostic: boundedCleanupDiagnostic(diagnostic),
          },
        };
        yield* publish;
        Deferred.doneUnsafe(record.cleanupSettlement, Effect.succeed("quarantined"));
        const evidence = record.view.cleanup?.diagnostic;
        yield* Effect.logWarning("Subagent cleanup remains quarantined.").pipe(
          Effect.annotateLogs({
            runId: record.view.id,
            cleanupPhase: evidence?.phase,
            cleanupCode: evidence?.code,
            cleanupReason: evidence?.message,
          }),
        );
      }),
    );

  const detachWriterPoolAfterCleanup = (
    record: RunRecord,
    scope: Scope.Closeable,
    expectedProcess?: BackendHandle,
  ) =>
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
        Effect.gen(function* () {
          if (
            record.scope !== scope ||
            record.writerPool !== pool ||
            (expectedProcess && record.process !== expectedProcess)
          )
            return undefined;
          if (pool.leaseCleanupUncertain)
            return yield* processError(
              "release writer lease",
              "writer_lease_cleanup_uncertain",
              "Writer lease cleanup is uncertain; its commit cannot be retried.",
            );
          const releasing = pool.detachAfterCleanupLocked(record.view.id);
          if (!pool.members.has(record.view.id)) record.writerPool = undefined;
          return releasing;
        }),
      );
      if (!release) return;
      yield* Scope.close(release, Exit.void);
      yield* withLock(
        Effect.sync(() => {
          if (record.scope !== scope || record.writerPool !== pool) return;
          if (writerPools.completeReleaseLocked(pool, record.view.id))
            record.writerPool = undefined;
        }),
      );
    });

  const scopeFailure = (record: RunRecord, scope: Scope.Closeable, cause: Cause.Cause<unknown>) => {
    const process = record.process;
    const verifier = process?.cleanupVerifier;
    const diagnostics = cause.reasons.map((reason) => verifier?.diagnostic(reason));
    const allAttested =
      diagnostics.length > 0 && diagnostics.every((diagnostic) => diagnostic !== undefined);
    const recoverable =
      allAttested &&
      verifier?.canVerify() === true &&
      diagnostics.every(
        (diagnostic) =>
          diagnostic?.phase === "process-exit" ||
          diagnostic?.phase === "process-group" ||
          diagnostic?.phase === "descendant-groups",
      );
    return retainCleanupQuarantine(
      record,
      scope,
      allAttested && diagnostics[0] ? diagnostics[0] : failureDiagnostic("backend-scope", cause),
      recoverable ? process : undefined,
    );
  };

  // A scope is closed once. Cached Scope.close success is never evidence of later cleanup.
  const closeRecordScope = (
    record: RunRecord,
    scope: Scope.Closeable = record.scope,
  ): Effect.Effect<void> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const closeSettled = yield* Deferred.make<void>();
        const claim = yield* withLock(
          Effect.sync(() => {
            if (record.scope !== scope) return { close: false as const, settled: undefined };
            if (record.closingScope === scope)
              return { close: false as const, settled: record.closingScopeSettled };
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
        yield* Effect.gen(function* () {
          yield* markCleanupPending(record);
          const closed = yield* Effect.exit(Scope.close(scope, Exit.void));
          if (Exit.isFailure(closed)) return yield* scopeFailure(record, scope, closed.cause);
          const detached = yield* Effect.exit(detachWriterPoolAfterCleanup(record, scope));
          if (Exit.isFailure(detached))
            return yield* retainCleanupQuarantine(
              record,
              scope,
              failureDiagnostic("writer-lease", detached.cause),
            );
          yield* clearCleanupPending(record, scope);
          return undefined;
        }).pipe(Effect.ensuring(Deferred.succeed(closeSettled, undefined)));
      }),
    );

  const verifyCleanup = (record: RunRecord): Effect.Effect<void> =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const settled = yield* Deferred.make<void>();
        const cleanupSettlement = yield* Deferred.make<"confirmed" | "quarantined">();
        const claim = yield* withLock(
          Effect.gen(function* () {
            if (record.cleanupVerification)
              return { owned: false as const, settled: record.cleanupVerification.settled };
            const recovery = record.cleanupRecovery;
            if (
              record.cleanupDisposition !== "quarantined" ||
              !recovery ||
              record.scope !== recovery.scope ||
              record.process !== recovery.process ||
              record.writerPool?.leaseCleanupUncertain
            )
              return { owned: false as const, settled: undefined };
            const verification = { ...recovery, settled };
            record.cleanupVerification = verification;
            record.cleanupDisposition = "pending";
            record.cleanupSettlement = cleanupSettlement;
            record.view = {
              ...record.view,
              cleanup: { ...record.view.cleanup, disposition: "pending" },
            };
            yield* publish;
            return { owned: true as const, verification };
          }),
        );
        if (!claim.owned) {
          if (claim.settled) yield* Deferred.await(claim.settled);
          return;
        }
        const verification = claim.verification;
        const { scope, process } = verification;
        yield* Effect.gen(function* () {
          const observed = yield* Effect.exit(
            process.cleanupVerifier?.verify ??
              Effect.fail({
                phase: "backend-scope" as const,
                message: "Cleanup verifier is unavailable.",
              }),
          );
          const current = yield* withLock(
            Effect.sync(
              () =>
                record.scope === scope &&
                record.process === process &&
                record.cleanupVerification === verification &&
                record.cleanupRecovery?.process === process,
            ),
          );
          if (!current) return undefined;
          if (Exit.isFailure(observed)) {
            const reason = observed.cause.reasons[0];
            const diagnostic =
              reason && Cause.isFailReason(reason)
                ? reason.error
                : failureDiagnostic("backend-scope", observed.cause);
            const recoverable =
              observed.cause.reasons.every(Cause.isFailReason) &&
              diagnostic.phase !== "backend-scope" &&
              diagnostic.phase !== "descendant-snapshot";
            return yield* retainCleanupQuarantine(
              record,
              scope,
              record.view.cleanup?.diagnostic ?? diagnostic,
              recoverable ? process : undefined,
            );
          }
          const detached = yield* Effect.exit(detachWriterPoolAfterCleanup(record, scope, process));
          if (Exit.isFailure(detached))
            return yield* retainCleanupQuarantine(
              record,
              scope,
              failureDiagnostic("writer-lease", detached.cause),
            );
          yield* clearCleanupPending(record, scope);
          return undefined;
        }).pipe(
          Effect.ensuring(
            withLock(
              Effect.sync(() => {
                if (record.cleanupVerification === verification)
                  record.cleanupVerification = undefined;
                Deferred.doneUnsafe(settled, Effect.void);
              }),
            ),
          ),
        );
      }),
    );
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
    verifyCleanup,
    closeExitedScope,
  };
}

export type RunRecordCleanup = ReturnType<typeof recordCleanup>;
