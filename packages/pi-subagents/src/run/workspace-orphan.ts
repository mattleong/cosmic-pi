import * as Effect from "effect/Effect";
import type { WorkspaceListing } from "../workspace/model.ts";
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
    cwd: string,
    discard: Effect.Effect<void, SubagentError>,
  ): Effect.Effect<void, SubagentError> =>
    writerLeases.canonicalize(cwd).pipe(
      Effect.matchEffect({
        // A worker tree that no longer resolves has no writer left in it.
        onFailure: () => discard,
        onSuccess: (identity) =>
          Effect.acquireUseRelease(
            writerLeases
              .acquire({ cwd: identity, runId: `orphan-discard-${workspaceId}` })
              .pipe(
                Effect.mapError((error) =>
                  invalid(
                    "workspace_process_unsettled",
                    `A writer may still be running in this workspace.\n${error.message}`,
                  ),
                ),
              ),
            () => discard,
            (lease) =>
              writerLeases
                .release(lease)
                .pipe(
                  Effect.catch((error) =>
                    Effect.logWarning(`Orphan workspace writer lease release: ${error.message}`),
                  ),
                ),
          ),
      }),
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
      return yield* operations.withPermits(1)(
        withStoppedWriter(workspaceId, record.handle.cwd, discardOrphan(service, workspaceId)),
      );
    });
}
