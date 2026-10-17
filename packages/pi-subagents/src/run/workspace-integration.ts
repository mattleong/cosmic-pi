import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { WriterLease } from "../boundary/writer-lease.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import { isActiveRunState, SUBAGENT_ROOT_RUN_ID } from "./model.ts";
import {
  isWithin,
  mapWorkspaceError,
  runHoldsCwd,
  runsWithin,
  workspaceArtifactDirectory,
  type WorkspaceControlContext,
} from "./workspace-binding.ts";

export interface WorkspaceIntegrationOutcome {
  readonly workerRoot: string;
  readonly uncapturedPaths: ReadonlyArray<string>;
  readonly treeRemovalFailed: boolean;
  readonly remainingBackupPaths: ReadonlyArray<string>;
  readonly leaseReleaseUnconfirmed: boolean;
  /** Unresolved child workspaces created from the worker tree, which therefore stays. */
  readonly retainedForChildren?: ReadonlyArray<string> | undefined;
}

export function workspaceIntegrationOperations(context: WorkspaceControlContext) {
  const { records, withLock, writerLeases: leases, state, requireBinding, requireEngine } = context;
  const { requireChildrenResolved } = context;
  /**
   * The writer lease the integrating caller's own writer pool holds on its worker tree. A nested
   * workspace integrates into that tree, so acquiring the lease again would conflict with it.
   */
  const callerHeldLeaseDigest = (caller: string): string | undefined => {
    const pool = records.get(caller)?.writerPool;
    return pool?.lease !== undefined && pool.members.has(caller) ? pool.cwd.digest : undefined;
  };
  /**
   * Integrates the exact tested pair. Callers hold the operations permit and run lock; `held`
   * admits a binding that operation's token keeps busy.
   */
  const integrateLocked = (
    workspaceId: string,
    revisionId: string,
    preparationId: string,
    caller: string,
    held?: symbol,
  ): Effect.Effect<WorkspaceIntegrationOutcome, SubagentError> =>
    Effect.gen(function* () {
      const binding = yield* requireBinding(workspaceId, caller, held);
      const service = yield* requireEngine;
      yield* requireChildrenResolved(binding);
      if (state.integrationQuarantined)
        return yield* invalid(
          "workspace_integration_quarantined",
          "Integration ownership is quarantined; further integration is blocked pending manual recovery.",
        );
      // Worktree launches need no check: the engine's source lock orders their snapshots. The
      // caller is exempt, so a worktree writer can integrate its child into its own worker tree.
      const { sourceRoot } = binding.handle;
      const overlapsTarget = (cwd: string) =>
        isWithin(cwd, sourceRoot) || isWithin(sourceRoot, cwd);
      if (
        [...state.sharedReservations].some((reservation) => overlapsTarget(reservation.cwd)) ||
        [...records.values()].some(
          (record) =>
            record.view.id !== caller &&
            record.view.writeIntent === "writer" &&
            record.view.writerWorkspaceMode !== "worktree" &&
            overlapsTarget(record.view.cwd) &&
            (isActiveRunState(record.view.state) || record.cleanupPending),
        )
      )
        return yield* invalid(
          "workspace_target_busy",
          "A shared-checkout writer is still active or launching in the integration target.",
        );
      if (binding.verificationFailedPreparation === preparationId)
        return yield* invalid(
          "workspace_verification_failed",
          "This preparation failed verification and cannot be integrated. Revise or discard the workspace, or review every page, prepare again, and integrate the new preparation.",
        );
      const artifact = yield* service
        .inspect({ workspaceId, ownerId: binding.handle.ownerId })
        .pipe(Effect.mapError(mapWorkspaceError));
      if (
        binding.reopenPending ||
        binding.testedPreparation !== preparationId ||
        !artifact.preparation ||
        artifact.preparation.preparationId !== preparationId ||
        artifact.preparation.revisionId !== revisionId
      )
        return yield* invalid(
          "workspace_preparation_stale",
          "The tested integration preparation no longer matches this revision.",
        );
      const roots = yield* Effect.forEach(artifact.preparation.leaseDirectories, (cwd) =>
        leases.canonicalize(cwd).pipe(Effect.mapError(mapWorkspaceError)),
      );
      const ownLease = callerHeldLeaseDigest(caller);
      const sources = [...new Map(roots.map((cwd) => [cwd.digest, cwd])).values()]
        .filter((cwd) => cwd.digest !== ownLease)
        .toSorted((left, right) => left.digest.localeCompare(right.digest));
      const directory = workspaceArtifactDirectory(artifact.handle);
      if (!directory)
        return yield* invalid(
          "workspace_owner_unavailable",
          "Workspace paths do not match the managed artifact layout.",
        );
      const retainTrees = [...runsWithin(records, [directory]).keys()].some(runHoldsCwd);
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const owned: WriterLease[] = [];
          let applying = false;
          let releaseFailed = false;
          const { record: _record, ...committed } = yield* Effect.gen(function* () {
            for (const cwd of sources)
              owned.push(
                yield* leases
                  .acquire({ cwd, runId: workspaceId })
                  .pipe(Effect.mapError(mapWorkspaceError)),
              );
            yield* restore(Effect.void);
            for (const lease of owned)
              yield* leases.markSpawnStarted(lease).pipe(Effect.mapError(mapWorkspaceError));
            applying = true;
            const integration = yield* service
              .integrate({
                workspaceId,
                ownerId: binding.handle.ownerId,
                revisionId,
                preparationId,
                processCleanupConfirmed: true,
                retainTrees,
              })
              .pipe(Effect.mapError(mapWorkspaceError));
            applying = false;
            binding.finished = true;
            binding.integrated = true;
            return integration;
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                if (applying) {
                  const current = yield* service
                    .inspect({ workspaceId, ownerId: binding.handle.ownerId })
                    .pipe(Effect.option);
                  if (Option.isNone(current) || current.value.status === "integrating") {
                    state.integrationQuarantined = true;
                    binding.finished = true;
                    return;
                  }
                }
                for (const lease of owned.toReversed())
                  yield* leases.release(lease).pipe(
                    Effect.catch(() =>
                      Effect.sync(() => {
                        releaseFailed = true;
                        state.integrationQuarantined = true;
                      }),
                    ),
                  );
              }),
            ),
          );
          if (releaseFailed)
            yield* Effect.logWarning(
              "Integration lease release is unconfirmed. Further writer admission is blocked pending manual recovery.",
            ).pipe(Effect.annotateLogs("workspaceId", workspaceId));
          return { ...committed, leaseReleaseUnconfirmed: releaseFailed };
        }),
      );
    });
  const workspaceIntegrate = (
    workspaceId: string,
    revisionId: string,
    preparationId: string,
    caller = SUBAGENT_ROOT_RUN_ID,
  ): Effect.Effect<WorkspaceIntegrationOutcome, SubagentError> =>
    context.operations.withPermits(1)(
      withLock(integrateLocked(workspaceId, revisionId, preparationId, caller)),
    );
  return { workspaceIntegrate, integrateLocked };
}
