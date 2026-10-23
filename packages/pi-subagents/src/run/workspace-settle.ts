import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { SubagentError } from "./errors.ts";
import type { RunRecord } from "./internal.ts";
import { diffStatTotals, type WorkspaceDiffStatFile } from "../workspace/diffstat.ts";
import { MAX_OUTCOME_DIFFSTAT_FILES, type SubagentWorkspaceDiffStat } from "./model.ts";
import {
  mapWorkspaceError,
  recordWorkspaceOutcomeLocked,
  runHoldsCwd,
  runsWithin,
  type WorkspaceBinding,
  type WorkspaceControlContext,
} from "./workspace-binding.ts";
import type { workspaceReviewOperations } from "./workspace-review.ts";

const outcomeFile = (file: WorkspaceDiffStatFile): SubagentWorkspaceDiffStat["files"][number] => ({
  path: file.path,
  addedLines: file.addedLines,
  deletedLines: file.deletedLines,
  ...(file.binary && { binary: true as const }),
});

const outcomeDiffStat = (
  files: ReadonlyArray<WorkspaceDiffStatFile>,
): SubagentWorkspaceDiffStat => ({
  ...diffStatTotals(files),
  files: Arr.map(files.slice(0, MAX_OUTCOME_DIFFSTAT_FILES), outcomeFile),
});

/**
 * Best-effort cleanup once a completed worktree writer's processes are confirmed stopped: a
 * workspace whose tree matches its baseline, with no uncaptured files, is discarded; any other
 * records its change counts and bounded diffstat. It never delays report delivery, and any doubt
 * keeps the workspace.
 */
export function workspaceSettleOperations(
  context: WorkspaceControlContext,
  publish: Effect.Effect<void>,
  discardLocked: ReturnType<typeof workspaceReviewOperations>["held"]["discardLocked"],
) {
  const { engine, records, state, withLock, operations } = context;
  // The parent may already be reviewing or applying it; only an untouched, settled
  // workspace that no run still uses is eligible. The engine refuses a quarantined one.
  const eligibleLocked = (
    record: RunRecord,
    assignmentEpoch: number,
  ): WorkspaceBinding | undefined => {
    const workspaceId = record.view.workspaceId;
    const binding = workspaceId === undefined ? undefined : state.bindings.get(workspaceId);
    if (
      !binding ||
      binding.record !== record ||
      record.view.state !== "completed" ||
      record.assignment.epoch !== assignmentEpoch ||
      record.process !== undefined ||
      record.cleanupDisposition !== "confirmed" ||
      binding.state.phase !== "idle" ||
      binding.state.knowledge.kind !== "unreviewed"
    )
      return undefined;
    if (Arr.some([...runsWithin(records, [binding.handle.artifactRoot]).keys()], runHoldsCwd))
      return undefined;
    return binding;
  };
  const settle = Effect.fn("WorkspaceSettle.settle")(
    function* (record: RunRecord, assignmentEpoch: number) {
      if (!engine) return;
      const cleanup = yield* withLock(
        Effect.sync(() =>
          record.cleanupDisposition === "confirmed" ? undefined : record.cleanupSettlement,
        ),
      );
      if (cleanup && (yield* Deferred.await(cleanup)) !== "confirmed") return;
      yield* operations.withPermits(1)(
        Effect.gen(function* () {
          const binding = yield* withLock(
            Effect.sync(() => eligibleLocked(record, assignmentEpoch)),
          );
          if (!binding) return;
          const { workspaceId, ownerId } = binding.handle;
          const changes = yield* engine
            .inspectWorkerChanges({ workspaceId, ownerId, processCleanupConfirmed: true })
            .pipe(Effect.mapError(mapWorkspaceError));
          yield* withLock(
            Effect.uninterruptible(
              Effect.gen(function* () {
                if (eligibleLocked(record, assignmentEpoch) !== binding) return;
                const changedFileCount = changes.changedPaths.length;
                const uncapturedFileCount = changes.uncapturedPaths.length;
                // Discard records the auto-discarded outcome itself.
                if (changedFileCount === 0 && uncapturedFileCount === 0) {
                  yield* discardLocked(engine, binding, "auto-discarded");
                  return;
                }
                recordWorkspaceOutcomeLocked(binding, {
                  status: "proposal",
                  changedFileCount,
                  ...(uncapturedFileCount > 0 && { uncapturedFileCount }),
                  ...(changes.diffStat.length > 0 && {
                    diffStat: outcomeDiffStat(changes.diffStat),
                  }),
                });
                yield* publish;
              }),
            ),
          );
        }),
      );
    },
    (effect, record) =>
      effect.pipe(
        Effect.catch((error: SubagentError) =>
          Effect.logWarning(`Kept a completed writer's workspace: ${error.message}`).pipe(
            Effect.annotateLogs({ runId: record.view.id, workspaceId: record.view.workspaceId }),
          ),
        ),
      ),
  );
  return settle;
}
