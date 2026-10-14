import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { WriterLease } from "../boundary/writer-lease.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import { isActiveRunState, SUBAGENT_ROOT_RUN_ID } from "./model.ts";
import {
  mapWorkspaceError,
  runHoldsCwd,
  runsWithin,
  type WorkspaceControlContext,
} from "./workspace-binding.ts";

export interface WorkspaceIntegrationOutcome {
  readonly workerRoot: string;
  readonly uncapturedPaths: ReadonlyArray<string>;
  readonly treeRemovalFailed: boolean;
  readonly leaseReleaseUnconfirmed: boolean;
}

export function workspaceIntegrationOperations(context: WorkspaceControlContext) {
  const { records, withLock, writerLeases: leases, state, requireBinding, requireEngine } = context;
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
          const sources = [...new Map(roots.map((cwd) => [cwd.digest, cwd])).values()].toSorted(
            (left, right) => left.digest.localeCompare(right.digest),
          );
          const proposalTrees = [
            binding.handle.cwd,
            artifact.preparation.cwd,
            ...(binding.record ? [binding.record.view.cwd] : []),
          ];
          const retainTrees = [...runsWithin(records, proposalTrees).keys()].some(runHoldsCwd);
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
        }),
      ),
    );
}
