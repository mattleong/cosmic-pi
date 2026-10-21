import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { WriterLease } from "../boundary/writer-lease.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import { isCleanupOwed } from "./internal.ts";
import { isActiveRunState } from "./model.ts";
import {
  isWithin,
  mapWorkspaceError,
  recordWorkspaceOutcomeLocked,
  revisionKnowledge,
  runHoldsCwd,
  runsWithin,
  settleBinding,
  type WorkspaceControlContext,
} from "./workspace-binding.ts";

export interface WorkspaceIntegrationOutcome {
  readonly workerRoot: string;
  /** Parent files the proposal doesn't touch that changed after preparation; they were kept. */
  readonly untouchedDriftPaths: ReadonlyArray<string>;
  readonly treeRemovalFailed: boolean;
  readonly leaseReleaseUnconfirmed: boolean;
}

/** A committed integration with what the coordinator knew of its revision and preparation. */
export interface WorkspaceIntegrationResult extends WorkspaceIntegrationOutcome {
  /** Every path the integration published. */
  readonly changedPaths: ReadonlyArray<string>;
  /** Credential files the worker created, which the revision leaves out on purpose. */
  readonly leftOutPaths: ReadonlyArray<string>;
  readonly preparedCwd: string;
}

/** Integration of an exact prepared pair, which apply composes; see `integrateLocked`. */
export function workspaceIntegrationOperations(
  context: WorkspaceControlContext,
  publish: Effect.Effect<void>,
) {
  const { records, writerLeases: leases, state, requireBinding, requireEngine } = context;
  /**
   * Integrates the exact prepared pair. Callers hold the operations permit and run lock; `held`
   * admits a binding that operation's token keeps busy.
   */
  const integrateLocked = (
    workspaceId: string,
    revisionId: string,
    preparationId: string,
    caller: string,
    held?: symbol,
  ): Effect.Effect<WorkspaceIntegrationResult, SubagentError> =>
    Effect.gen(function* () {
      const binding = yield* requireBinding(workspaceId, caller, held);
      const service = yield* requireEngine;
      if (state.integrationQuarantined)
        return yield* invalid(
          "workspace_integration_quarantined",
          "Integration ownership is quarantined; further integration is blocked pending manual recovery.",
        );
      // Worktree launches need no check: the engine's source lock orders their snapshots.
      const { sourceRoot } = binding.handle;
      const overlapsTarget = (cwd: string) =>
        isWithin(cwd, sourceRoot) || isWithin(sourceRoot, cwd);
      if (
        [...state.sharedReservations].some((reservation) => overlapsTarget(reservation.cwd)) ||
        [...records.values()].some(
          (record) =>
            record.view.writeIntent === "writer" &&
            record.view.writerWorkspaceMode !== "worktree" &&
            overlapsTarget(record.view.cwd) &&
            (isActiveRunState(record.view.state) || isCleanupOwed(record)),
        )
      )
        return yield* invalid(
          "workspace_target_busy",
          "A shared-checkout writer is still active or launching in the integration target.",
        );
      const knowledge = revisionKnowledge(binding);
      const recorded = knowledge?.kind === "prepared" && knowledge.preparationId === preparationId;
      const artifact = yield* service
        .inspect({ workspaceId, ownerId: binding.handle.ownerId })
        .pipe(Effect.mapError(mapWorkspaceError));
      if (
        !recorded ||
        !artifact.preparation ||
        artifact.preparation.preparationId !== preparationId ||
        artifact.preparation.revisionId !== revisionId ||
        artifact.revision?.revisionId !== revisionId
      )
        return yield* invalid(
          "workspace_preparation_stale",
          "The tested integration preparation no longer matches this revision.",
        );
      const known = {
        changedPaths: artifact.revision.changedPaths,
        leftOutPaths: artifact.revision.uncapturedPaths ?? [],
        preparedCwd: artifact.preparation.cwd,
      };
      // The checkout's writer pool leases, so no shared-checkout writer of another session edits
      // it while the files are written.
      const roots = yield* Effect.forEach([sourceRoot, binding.handle.sourceCwd], (cwd) =>
        leases.canonicalize(cwd).pipe(Effect.mapError(mapWorkspaceError)),
      );
      const sources = [...new Map(roots.map((cwd) => [cwd.digest, cwd])).values()].toSorted(
        (left, right) => left.digest.localeCompare(right.digest),
      );
      const retainTrees = [...runsWithin(records, [artifact.handle.artifactRoot]).keys()].some(
        runHoldsCwd,
      );
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
            settleBinding(binding, { phase: "finished", outcome: "integrated" });
            recordWorkspaceOutcomeLocked(binding, { status: "integrated" });
            yield* publish;
            return integration;
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                if (applying) {
                  const current = yield* service
                    .inspect({ workspaceId, ownerId: binding.handle.ownerId })
                    .pipe(Effect.option);
                  if (Option.isNone(current)) {
                    state.integrationQuarantined = true;
                    settleBinding(binding, { phase: "finished", outcome: "unknown" });
                    return;
                  }
                  // Only discard, which rolls the touched files back, may follow.
                  if (current.value.status === "integrating")
                    settleBinding(binding, { phase: "stopped-integration" });
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
          return { ...committed, ...known, leaseReleaseUnconfirmed: releaseFailed };
        }),
      );
    });
  return integrateLocked;
}
