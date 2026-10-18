import * as Effect from "effect/Effect";
import type {
  WorkspaceError,
  WorkspaceExport,
  WorkspaceExportRequest,
  WorkspaceHandle,
  WorkspaceListing,
  WorkspaceRecord,
} from "../workspace/model.ts";
import type { WorkspaceServiceContract } from "../workspace/service.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import { mapWorkspaceError, type WorkspaceControlContext } from "./workspace-binding.ts";

const ORPHAN_UNAVAILABLE =
  "This session can only discard or export an orphaned workspace of its own checkout whose session has ended.";

const orphanError = (error: WorkspaceError) => {
  switch (error.operation) {
    case "authorization":
      return invalid("workspace_owner_unavailable", `${error.message}\n${ORPHAN_UNAVAILABLE}`);
    case "revision":
      return invalid("workspace_revision_stale", error.message);
    default:
      return mapWorkspaceError(error);
  }
};

/**
 * Lets the root discard or export a workspace left by a session that has ended. The engine proves
 * the session ended through its owner lease; holding the writer lease on the worker tree proves no
 * writer is still running there. Export reads the artifact without changing it.
 */
export function workspaceOrphanOperations(
  context: WorkspaceControlContext,
  visibleRecords: (listing: WorkspaceListing) => Effect.Effect<WorkspaceListing, SubagentError>,
) {
  const { requireEngine, writerLeases, operations } = context;
  const withStoppedWriter = <A>(
    action: "discard" | "export",
    workspaceId: string,
    handle: WorkspaceHandle,
    use: Effect.Effect<A, SubagentError>,
  ): Effect.Effect<A, SubagentError> =>
    handle.writerCwd === undefined
      ? Effect.fail(
          invalid(
            "workspace_process_unsettled",
            "This saved workspace has no original writer-directory identity. Automatic discard or export is unsafe. Independently confirm every writer and descendant has stopped, preserve the proposal and recovery record, then recover its private trees manually.",
          ),
        )
      : Effect.acquireUseRelease(
          writerLeases
            .acquire({ cwd: handle.writerCwd, runId: `orphan-${action}-${workspaceId}` })
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
                current.filesystemIdentity === handle.writerCwd?.filesystemIdentity
                  ? use
                  : Effect.fail(
                      invalid(
                        "workspace_process_unsettled",
                        "The worker path now names a different directory. Automatic discard or export is unsafe; preserve both trees and the recovery record and recover them manually after confirming all writers have stopped.",
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
  /** Finds the orphan among this checkout's records once it has no unresolved children. */
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
      // The engine refuses discard too; this names the children to discard first.
      const children = yield* service
        .unresolvedChildren({ workspaceId })
        .pipe(Effect.mapError(mapWorkspaceError));
      if (children.length > 0)
        return yield* invalid(
          "workspace_children_unresolved",
          `Child workspaces created from this workspace are unresolved (${children.join(", ")}). Discard them first, children before their parent.`,
        );
      return record;
    });
  const discardOrphan = (workspaceId: string): Effect.Effect<void, SubagentError> =>
    Effect.gen(function* () {
      const service = yield* requireEngine;
      const record = yield* orphanRecord(service, workspaceId);
      return yield* operations.withPermits(1)(
        withStoppedWriter(
          "discard",
          workspaceId,
          record.handle,
          service.discardOrphan({ workspaceId }).pipe(Effect.mapError(orphanError)),
        ),
      );
    });
  const exportOrphan = (
    workspaceId: string,
    revisionId: string | undefined,
    request: WorkspaceExportRequest,
  ): Effect.Effect<WorkspaceExport, SubagentError> =>
    Effect.gen(function* () {
      const service = yield* requireEngine;
      const record = yield* orphanRecord(service, workspaceId);
      return yield* operations.withPermits(1)(
        withStoppedWriter(
          "export",
          workspaceId,
          record.handle,
          service
            .exportOrphan({ workspaceId, revisionId, export: request })
            .pipe(Effect.mapError(orphanError)),
        ),
      );
    });
  return { discardOrphan, exportOrphan };
}
