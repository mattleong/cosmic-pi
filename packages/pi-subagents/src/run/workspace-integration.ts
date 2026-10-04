import * as Effect from "effect/Effect";
import type { WriterLease } from "../boundary/writer-lease.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import { isActiveRunState, SUBAGENT_ROOT_RUN_ID } from "./model.ts";
import {
  mapWorkspaceError,
  runHoldsCwd,
  runsWithin,
  type WorkspaceControlContext,
} from "./workspace-binding.ts";

/** What a committed integration left for the parent to resolve. */
export interface WorkspaceIntegrationOutcome {
  /** The proposal's worker tree root, where a kept or unremoved tree remains. */
  readonly workerRoot: string;
  /** Worker files outside the integrated revision, relative to `workerRoot`; it was kept. */
  readonly uncapturedPaths: ReadonlyArray<string>;
  /** Removing the spent editable trees failed, so they remain on disk. */
  readonly treeRemovalFailed: boolean;
  /** The source lease release is unconfirmed, so writer admission stays quarantined. */
  readonly leaseReleaseUnconfirmed: boolean;
}

/** Integration of an exact reviewed and tested revision under the source writer leases. */
export function makeWorkspaceIntegrate(context: WorkspaceControlContext) {
  const { records, withLock, writerLeases: leases, state, requireBinding, requireEngine } = context;
  // Integration keeps the run lock throughout, so no writer is admitted to its source meanwhile;
  // it still queues behind root operations whose engine work runs outside that lock.
  return (
    workspaceId: string,
    revisionId: string,
    preparationId: string,
    caller = SUBAGENT_ROOT_RUN_ID,
  ): Effect.Effect<WorkspaceIntegrationOutcome, SubagentError> =>
    context.operations.withPermits(1)(
      withLock(
        Effect.gen(function* () {
          const binding = yield* requireBinding(workspaceId, caller);
          const service = yield* requireEngine;
          if (state.integrationQuarantined)
            return yield* invalid(
              "workspace_integration_quarantined",
              "Integration ownership is quarantined; further integration is blocked pending manual recovery.",
            );
          if (
            state.reservations > 0 ||
            [...records.values()].some(
              (record) =>
                record.view.writeIntent === "writer" &&
                record.view.cwd === binding.handle.sourceCwd &&
                (isActiveRunState(record.view.state) || record.cleanupPending),
            )
          )
            return yield* invalid(
              "workspace_target_busy",
              "The integration target still has writer ownership or admission reservations.",
            );
          const artifact = yield* service
            .inspect({ workspaceId, ownerId: binding.handle.ownerId })
            .pipe(Effect.mapError(mapWorkspaceError));
          // A pending reopen makes the preparation the engine still holds stale.
          if (
            binding.reopenPending ||
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
          const sources = [...new Map(roots.map((cwd) => [cwd.digest, cwd])).values()].sort(
            (left, right) => left.digest.localeCompare(right.digest),
          );
          // A live run inside the proposal, such as a reader its writer started, keeps the trees.
          const proposalTrees = [
            binding.handle.cwd,
            artifact.preparation.cwd,
            ...(binding.record ? [binding.record.view.cwd] : []),
          ];
          const retainTrees = [...runsWithin(records, proposalTrees).keys()].some(runHoldsCwd);
          // The engine lists every existing touched-file ancestor, so subdirectory-scoped cooperative writers conflict too.
          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const owned: WriterLease[] = [];
              let applying = false;
              let releaseFailed = false;
              const committed = yield* Effect.gen(function* () {
                for (const cwd of sources)
                  owned.push(
                    // acquire keeps only its pre-ownership checks interruptible. Keep the
                    // returned lease masked until the finalizer can see it.
                    yield* leases
                      .acquire({ cwd, runId: workspaceId })
                      .pipe(Effect.mapError(mapWorkspaceError)),
                  );
                yield* restore(Effect.void);
                // Crash evidence must not be reclaimed as an unused reservation after source publication starts.
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
                      if (current._tag === "None" || current.value.status === "integrating") {
                        state.integrationQuarantined = true;
                        binding.finished = true;
                        return;
                      }
                    }
                    for (const lease of owned.reverse())
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
              // The integration committed. An unconfirmed lease release blocks later writers instead.
              if (releaseFailed)
                yield* Effect.logWarning(
                  "Integration lease release is unconfirmed. Further writer admission is blocked pending manual recovery.",
                ).pipe(Effect.annotateLogs("workspaceId", workspaceId));
              return {
                workerRoot: committed.workerRoot,
                uncapturedPaths: committed.uncapturedPaths,
                treeRemovalFailed: committed.treeRemovalFailed,
                leaseReleaseUnconfirmed: releaseFailed,
              };
            }),
          );
        }),
      ),
    );
}
