import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import {
  isOriginalWorker,
  OPEN_WORKSPACE_STATUSES,
  type WorkspaceError,
  type WorkspaceHandle,
  type WorkspaceListing,
  type WorkspaceRecord,
  type WorkspaceSwept,
} from "../workspace/model.ts";
import type { WorkspaceServiceContract } from "../workspace/service.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import { SUBAGENT_ROOT_RUN_ID } from "./model.ts";
import {
  mapWorkspaceError,
  UNREVIEWED,
  type WorkspaceBinding,
  type WorkspaceControlContext,
} from "./workspace-binding.ts";
import { integrationTarget } from "./workspace-integration.ts";

const ORPHAN_UNAVAILABLE =
  "This session can only adopt or discard an orphaned workspace of its own checkout whose session has ended.";

/** Orphans unchanged this long are discarded at root startup, keeping their revision patch. */
const ORPHAN_SWEEP_AGE = Duration.days(30);

/**
 * What the root may do with another session's unfinished workspace once that session ended:
 * adopt an open one and continue it, or only discard it.
 */
export type OrphanDisposition = "adoptable" | "discard-only";

/**
 * The listing's verdict for one record, from its advisory owner probe; adoption and discard
 * recheck everything under the checkout's lock.
 */
export const orphanDisposition = (
  record: WorkspaceRecord,
  listing: WorkspaceListing,
): OrphanDisposition | undefined => {
  const { workspaceId } = record.handle;
  if (!listing.endedOwners?.includes(workspaceId)) return undefined;
  if (record.handle.writerCwd === undefined) return undefined;
  return OPEN_WORKSPACE_STATUSES.has(record.status) ? "adoptable" : "discard-only";
};

const orphanError = (error: WorkspaceError) => {
  switch (error.operation) {
    case "authorization":
      return invalid("workspace_owner_unavailable", `${error.message}\n${ORPHAN_UNAVAILABLE}`);
    case "adopt":
      return invalid(
        "workspace_orphan_discard_only",
        error.detail === undefined ? error.message : `${error.message}\n${error.detail}`,
      );
    case "revision":
      return invalid("workspace_revision_stale", error.message);
    default:
      return mapWorkspaceError(error);
  }
};

/**
 * Lets the root adopt or discard a workspace left by a session that has ended. The engine proves
 * the session ended through its owner lease; holding the writer lease on the worker tree proves no
 * writer is still running there.
 */
export function workspaceOrphanOperations(
  context: WorkspaceControlContext,
  visibleRecords: (listing: WorkspaceListing) => Effect.Effect<WorkspaceListing, SubagentError>,
) {
  const { requireEngine, writerLeases, operations, state, withLock, ownerFor } = context;
  const checkout = integrationTarget(context);
  const withStoppedWriter = <A>(
    workspaceId: string,
    handle: WorkspaceHandle,
    use: Effect.Effect<A, SubagentError>,
  ): Effect.Effect<A, SubagentError> =>
    handle.writerCwd === undefined
      ? Effect.fail(
          invalid(
            "workspace_process_unsettled",
            "This saved workspace has no original writer-directory identity. Automatic discard is unsafe. Independently confirm every writer and descendant has stopped, preserve the proposal and recovery record, then recover its private trees manually.",
          ),
        )
      : Effect.acquireUseRelease(
          writerLeases
            .acquire({ cwd: handle.writerCwd, runId: `orphan-discard-${workspaceId}` })
            .pipe(
              Effect.mapError((error) =>
                invalid(
                  "workspace_process_unsettled",
                  `A writer may still be running in this workspace.\n${error.message}`,
                ),
              ),
            ),
          () =>
            writerLeases.canonicalize(handle.cwd).pipe(
              Effect.mapError(() =>
                invalid(
                  "workspace_process_unsettled",
                  "The original worker directory no longer resolves. Preserve its trees and recovery record, confirm every writer and descendant has stopped, then recover the artifact manually.",
                ),
              ),
              Effect.flatMap((current) =>
                isOriginalWorker(handle, current)
                  ? use
                  : Effect.fail(
                      invalid(
                        "workspace_process_unsettled",
                        "The worker path now names a different directory. Automatic discard is unsafe; preserve both trees and the recovery record and recover them manually after confirming all writers have stopped.",
                      ),
                    ),
              ),
            ),
          (lease) =>
            writerLeases
              .release(lease)
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning(`Orphan workspace writer lease release: ${error.message}`),
                ),
              ),
        );
  /** Finds the orphan among this checkout's records. */
  const orphanRecord = (
    service: WorkspaceServiceContract,
    workspaceId: string,
  ): Effect.Effect<WorkspaceRecord, SubagentError> =>
    Effect.gen(function* () {
      const listing = yield* service.listAll.pipe(
        Effect.mapError(mapWorkspaceError),
        Effect.flatMap(visibleRecords),
      );
      const record = listing.records.find((entry) => entry.handle.workspaceId === workspaceId);
      if (!record) return yield* invalid("workspace_owner_unavailable", ORPHAN_UNAVAILABLE);
      return record;
    });
  const discardOrphan = (workspaceId: string): Effect.Effect<void, SubagentError> =>
    Effect.gen(function* () {
      const service = yield* requireEngine;
      const record = yield* orphanRecord(service, workspaceId);
      const discard = service.discardOrphan({ workspaceId }).pipe(Effect.mapError(orphanError));
      // A mid-integration record stays so until its discard, whose rollback writes the parent's
      // files like integration.
      return yield* operations.withPermits(1)(
        withStoppedWriter(
          workspaceId,
          record.handle,
          record.status === "integrating"
            ? withLock(
                checkout
                  .requireIdleLocked(record.handle.sourceRoot)
                  .pipe(Effect.andThen(checkout.holdLocked(workspaceId, record.handle, discard))),
              ).pipe(Effect.asVoid)
            : discard,
        ),
      );
    });
  /**
   * Takes over an orphan for the root, which then reviews, applies, revises, or discards it like
   * its own: the coordinator binds it without a run, unreviewed, with its recorded launch for a
   * revision successor. Mid-integration orphans stay discard-only.
   */
  const adopt = (workspaceId: string): Effect.Effect<void, SubagentError> =>
    Effect.gen(function* () {
      const service = yield* requireEngine;
      yield* operations.withPermits(1)(
        Effect.gen(function* () {
          // An earlier call may have adopted it while this one waited.
          if (yield* withLock(Effect.sync(() => state.bindings.has(workspaceId)))) return;
          const record = yield* orphanRecord(service, workspaceId);
          const handle = yield* withStoppedWriter(
            workspaceId,
            record.handle,
            service
              .adopt({ workspaceId, ownerId: ownerFor(SUBAGENT_ROOT_RUN_ID) })
              .pipe(Effect.mapError(orphanError)),
          );
          yield* withLock(
            Effect.sync(() => {
              if (state.bindings.has(workspaceId)) return;
              const binding: WorkspaceBinding = {
                handle,
                state: UNREVIEWED,
                ...(record.launch && { launch: record.launch }),
              };
              state.bindings.set(workspaceId, binding);
            }),
          );
        }),
      );
    });
  /**
   * Discards this checkout's orphans unchanged for 30 days, skipping any a takeover would refuse.
   * Each keeps its revision patch beside its record until collection.
   */
  const sweepOrphans: Effect.Effect<ReadonlyArray<WorkspaceSwept>, SubagentError> = Effect.gen(
    function* () {
      const service = yield* requireEngine;
      const minimumAgeMillis = Duration.toMillis(ORPHAN_SWEEP_AGE);
      // Only this session's checkout, like the root's listing; other checkouts sweep their own.
      const candidates = yield* service.sweepCandidates({ minimumAgeMillis }).pipe(
        Effect.mapError(mapWorkspaceError),
        Effect.flatMap((records) => visibleRecords({ records, unavailable: [] })),
        Effect.map((listing) => listing.records),
      );
      const swept: WorkspaceSwept[] = [];
      for (const record of candidates) {
        const { workspaceId } = record.handle;
        const outcome = yield* operations
          .withPermits(1)(
            withStoppedWriter(
              workspaceId,
              record.handle,
              service
                .sweepOrphan({ workspaceId, minimumAgeMillis })
                .pipe(Effect.mapError(orphanError)),
            ),
          )
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning(`Orphaned workspace was kept: ${error.message}`).pipe(
                Effect.annotateLogs("workspaceId", workspaceId),
                Effect.as(undefined),
              ),
            ),
          );
        if (outcome) swept.push(outcome);
      }
      return swept;
    },
  );
  return { discardOrphan, adopt, sweepOrphans };
}
