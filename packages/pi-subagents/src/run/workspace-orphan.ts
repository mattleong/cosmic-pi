import * as Effect from "effect/Effect";
import type { WorkspaceHandle, WorkspaceListing } from "../workspace/model.ts";
import type { WorkspaceServiceContract } from "../workspace/service.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import { mapWorkspaceError, type WorkspaceControlContext } from "./workspace-binding.ts";

const ORPHAN_UNAVAILABLE =
  "This session can only discard an orphaned workspace of its own checkout whose session has ended.";

/**
 * Lets the root discard a workspace left by a session that has ended. The engine proves the
 * session ended through its owner lease; holding the writer lease on the worker tree proves no
 * writer is still running there.
 */
export function workspaceOrphanOperations(
  context: WorkspaceControlContext,
  visibleRecords: (listing: WorkspaceListing) => Effect.Effect<WorkspaceListing, SubagentError>,
) {
  const { requireEngine, writerLeases, operations } = context;
  const withStoppedWriter = (
    workspaceId: string,
    handle: WorkspaceHandle,
    discard: Effect.Effect<void, SubagentError>,
  ): Effect.Effect<void, SubagentError> =>
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
                current.filesystemIdentity === handle.writerCwd?.filesystemIdentity
                  ? discard
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
  const discardOrphan = (
    service: WorkspaceServiceContract,
    workspaceId: string,
  ): Effect.Effect<void, SubagentError> =>
    service
      .discardOrphan({ workspaceId })
      .pipe(
        Effect.mapError((error) =>
          error.operation === "authorization"
            ? invalid("workspace_owner_unavailable", `${error.message}\n${ORPHAN_UNAVAILABLE}`)
            : mapWorkspaceError(error),
        ),
      );
  return (workspaceId: string): Effect.Effect<void, SubagentError> =>
    Effect.gen(function* () {
      const service = yield* requireEngine;
      const listing = yield* service.listAll.pipe(
        Effect.mapError(mapWorkspaceError),
        Effect.flatMap(visibleRecords),
      );
      const record = listing.records.find((entry) => entry.handle.workspaceId === workspaceId);
      if (!record) return yield* invalid("workspace_owner_unavailable", ORPHAN_UNAVAILABLE);
      // The engine refuses too; this names the children to discard first.
      const children = yield* service
        .unresolvedChildren({ workspaceId })
        .pipe(Effect.mapError(mapWorkspaceError));
      if (children.length > 0)
        return yield* invalid(
          "workspace_children_unresolved",
          `Child workspaces created from this workspace are unresolved (${children.join(", ")}). Discard them first, children before their parent.`,
        );
      return yield* operations.withPermits(1)(
        withStoppedWriter(workspaceId, record.handle, discardOrphan(service, workspaceId)),
      );
    });
}
