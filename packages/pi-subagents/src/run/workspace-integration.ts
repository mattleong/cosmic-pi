import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import type { CanonicalWriterCwd, WriterLease } from "../boundary/writer-lease.ts";
import type { WorkspaceHandle } from "../workspace/model.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import { isCleanupOwed } from "./internal.ts";
import { isActiveRunState } from "./model.ts";
import {
  type HeldBinding,
  isTreeInUse,
  mapWorkspaceError,
  overlaps,
  recordWorkspaceOutcomeLocked,
  revisionKnowledge,
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

/**
 * Integration and rollback both write the parent's files, so both refuse while a shared-checkout
 * writer is active or launching in the target and hold its writer-pool leases throughout. Their
 * exclusion of the target keeps this session's new runs out of it until they end.
 */
export function integrationTarget(context: WorkspaceControlContext) {
  const { records, writerLeases: leases, state, withLock } = context;
  /** Refuses while a shared-checkout writer of this session is active or launching in the target. */
  const requireIdleLocked = (sourceRoot: string): Effect.Effect<void, SubagentError> =>
    Effect.suspend(() => {
      // Worktree launches need no check: the engine orders their snapshots, queueing this
      // session's behind its operation gate and other sessions' behind the checkout's lock.
      const overlapsTarget = (cwd: string) => overlaps(cwd, sourceRoot);
      return Arr.some(
        [...state.launchReservations],
        (reservation) => reservation.sharedWriter && overlapsTarget(reservation.cwd),
      ) ||
        Arr.some(
          [...records.values()],
          (record) =>
            record.view.writeIntent === "writer" &&
            record.view.writerWorkspaceMode !== "worktree" &&
            overlapsTarget(record.view.cwd) &&
            (isActiveRunState(record.view.state) || isCleanupOwed(record)),
        )
        ? Effect.fail(
            invalid(
              "workspace_target_busy",
              "A shared-checkout writer is still active or launching in the integration target.",
            ),
          )
        : Effect.void;
    });
  /**
   * Runs `use`, uninterruptibly, holding the writer-pool leases on the source root and session
   * directory, so no shared-checkout writer of another session edits the checkout meanwhile.
   * `beforeRelease` runs once `use` ends, however it ends. A release that can't be confirmed
   * quarantines integration and writer admission until restart.
   */
  const holdTarget = Effect.fn("SubagentWorkspace.holdTarget")(function* <A>(
    workspaceId: string,
    handle: WorkspaceHandle,
    use: Effect.Effect<A, SubagentError>,
    beforeRelease: Effect.Effect<void> = Effect.void,
  ): Effect.fn.Return<
    { readonly value: A; readonly leaseReleaseUnconfirmed: boolean },
    SubagentError
  > {
    const roots = yield* Effect.forEach([handle.sourceRoot, handle.sourceCwd], (cwd) =>
      leases.canonicalize(cwd).pipe(Effect.mapError(mapWorkspaceError)),
    );
    const sources = Arr.sort(
      [...new Map(Arr.map(roots, (cwd) => [cwd.digest, cwd] as const)).values()],
      (left: CanonicalWriterCwd, right: CanonicalWriterCwd) =>
        Fn.pipe(left.digest, Str.localeCompare(right.digest)),
    );
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const owned: WriterLease[] = [];
        let releaseFailed = false;
        const value = yield* Effect.gen(function* () {
          for (const cwd of sources)
            owned.push(
              yield* leases
                .acquire({ cwd, runId: workspaceId })
                .pipe(
                  Effect.mapError((error) =>
                    Predicate.isTagged(error, "WriterLeaseConflictError") && error.reason === "live"
                      ? invalid(
                          "workspace_target_busy",
                          `A shared-checkout writer of another session holds the integration target.\n${error.message}`,
                        )
                      : mapWorkspaceError(error),
                  ),
                ),
            );
          yield* restore(Effect.void);
          for (const lease of owned)
            yield* leases.markSpawnStarted(lease).pipe(Effect.mapError(mapWorkspaceError));
          return yield* use;
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* beforeRelease;
              for (const lease of Arr.reverse(owned))
                yield* leases.release(lease).pipe(
                  Effect.catch(() =>
                    withLock(
                      Effect.sync(() => {
                        releaseFailed = true;
                        state.integrationQuarantined = true;
                      }),
                    ),
                  ),
                );
            }),
          ),
        );
        if (releaseFailed)
          yield* Effect.logWarning(
            "Integration lease release is unconfirmed. Further writer admission is blocked pending manual recovery.",
          ).pipe(Effect.annotateLogs("workspaceId", workspaceId));
        return { value, leaseReleaseUnconfirmed: releaseFailed };
      }),
    );
  });
  return { requireIdleLocked, holdTarget };
}

/** Integration of an exact prepared pair, which apply composes; see `integrateHeld`. */
export function workspaceIntegrationOperations(
  context: WorkspaceControlContext,
  publish: Effect.Effect<void>,
) {
  const { records, state, withLock, requireBinding, requireEngine, excludeTrees } = context;
  const checkout = integrationTarget(context);
  /**
   * Integrates the exact prepared pair of a binding `held` keeps busy. Callers hold the operations
   * permit. `beforeLocked` runs first in the claim under the run lock; the engine then integrates
   * outside it, excluding the workspace's trees and the target checkout.
   */
  const integrateHeld = Effect.fn("SubagentWorkspace.integrateHeld")(function* (
    { binding, token }: HeldBinding,
    caller: string,
    revisionId: string,
    preparationId: string,
    beforeLocked: Effect.Effect<void, SubagentError> = Effect.void,
  ): Effect.fn.Return<WorkspaceIntegrationResult, SubagentError> {
    const service = yield* requireEngine;
    const { workspaceId, ownerId, sourceRoot } = binding.handle;
    const artifact = yield* service
      .inspect({ workspaceId, ownerId })
      .pipe(Effect.mapError(mapWorkspaceError));
    const { artifactRoot } = artifact.handle;
    return yield* excludeTrees(
      Effect.gen(function* () {
        yield* beforeLocked;
        yield* requireBinding(workspaceId, caller, token);
        if (state.integrationQuarantined)
          return yield* invalid(
            "workspace_integration_quarantined",
            "Integration ownership is quarantined; further integration is blocked pending manual recovery.",
          );
        yield* checkout.requireIdleLocked(sourceRoot);
        const knowledge = revisionKnowledge(binding);
        const recorded =
          knowledge?.kind === "prepared" && knowledge.preparationId === preparationId;
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
        return {
          exclusion: { artifactRoot, target: sourceRoot },
          known: {
            changedPaths: artifact.revision.changedPaths,
            leftOutPaths: artifact.revision.uncapturedPaths ?? [],
            preparedCwd: artifact.preparation.cwd,
          },
          retainTrees: isTreeInUse(records, state.launchReservations, artifactRoot),
        };
      }),
      ({ known, retainTrees }) =>
        Effect.gen(function* () {
          let applying = false;
          const { value, leaseReleaseUnconfirmed } = yield* checkout.holdTarget(
            workspaceId,
            binding.handle,
            Effect.gen(function* () {
              applying = true;
              const integration = yield* service
                .integrate({
                  workspaceId,
                  ownerId,
                  revisionId,
                  preparationId,
                  processCleanupConfirmed: true,
                  retainTrees,
                })
                .pipe(Effect.mapError(mapWorkspaceError));
              applying = false;
              yield* withLock(
                Effect.suspend(() => {
                  settleBinding(binding, { phase: "finished", outcome: "integrated" });
                  recordWorkspaceOutcomeLocked(binding, { status: "integrated" });
                  return publish;
                }),
              );
              return integration;
            }),
            Effect.gen(function* () {
              if (!applying) return;
              const current = yield* service.inspect({ workspaceId, ownerId }).pipe(Effect.option);
              yield* withLock(
                Effect.sync(() => {
                  if (Option.isNone(current)) {
                    state.integrationQuarantined = true;
                    settleBinding(binding, { phase: "finished", outcome: "unknown" });
                    return;
                  }
                  // Only discard, which rolls the touched files back, may follow.
                  if (current.value.status === "integrating")
                    settleBinding(binding, { phase: "stopped-integration" });
                }),
              );
            }),
          );
          const { record: _record, ...committed } = value;
          return { ...committed, ...known, leaseReleaseUnconfirmed };
        }),
    );
  });
  return integrateHeld;
}
