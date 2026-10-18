import * as Effect from "effect/Effect";
import type { WorkspaceExport, WorkspaceExportRequest } from "../workspace/model.ts";
import { exportBranchName } from "../workspace/policy.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import { SUBAGENT_ROOT_RUN_ID } from "./model.ts";
import {
  isBindingFinished,
  mapWorkspaceError,
  type WorkspaceControlContext,
  workspaceFinishedError,
} from "./workspace-binding.ts";
import type { workspaceOrphanOperations } from "./workspace-orphan.ts";
import type { workspaceReviewOperations } from "./workspace-review.ts";

export const WORKSPACE_EXPORT_FORMATS = ["patch", "branch"] as const;
export type WorkspaceExportFormat = (typeof WORKSPACE_EXPORT_FORMATS)[number];

export interface WorkspaceExportOptions {
  /** Must match the current frozen revision; omitted, export freezes like review. */
  readonly revisionId?: string | undefined;
  /** Defaults to `patch`. */
  readonly format?: WorkspaceExportFormat | undefined;
}

export type WorkspaceExportResult = WorkspaceExport & {
  /** Exported by a later session's root from a workspace whose session ended. */
  readonly orphan: boolean;
};

const asOrphan = (exported: WorkspaceExport): WorkspaceExportResult => ({
  ...exported,
  orphan: true,
});

const exportRequest = (
  format: WorkspaceExportFormat,
  name: string | undefined,
  workspaceId: string,
): WorkspaceExportRequest =>
  format === "patch" ? { format } : { format, branch: exportBranchName(name, workspaceId) };

/**
 * Writes a proposal out of private storage as a patch file or branch in the source repository,
 * so it survives the workspace. The workspace stays an unresolved proposal. Its direct parent
 * exports it, freezing it like review; the root of a later session exports an orphan read-only.
 */
export function workspaceExportOperations(
  context: WorkspaceControlContext,
  phases: ReturnType<typeof workspaceReviewOperations>["held"],
  orphans: ReturnType<typeof workspaceOrphanOperations>,
) {
  const { withLock, requireEngine, state } = context;
  const exportOwned = (
    workspaceId: string,
    options: WorkspaceExportOptions,
    caller: string,
  ): Effect.Effect<WorkspaceExportResult, SubagentError> =>
    Effect.gen(function* () {
      const service = yield* requireEngine;
      return yield* phases.operate(workspaceId, caller, (held) =>
        Effect.gen(function* () {
          const { binding } = held;
          if (yield* withLock(Effect.sync(() => isBindingFinished(binding))))
            return yield* workspaceFinishedError(binding);
          if (binding.handle.sourceWorkspaceId !== undefined)
            return yield* invalid(
              "workspace_nested_export_unsupported",
              "A nested workspace can't be exported: its source is your own worker tree, not a real checkout. Apply or discard it instead.",
            );
          const revision = yield* phases.settledRevision(service, held, options.revisionId);
          const exported = yield* service
            .exportRevision({
              workspaceId,
              ownerId: binding.handle.ownerId,
              revisionId: revision.revisionId,
              export: exportRequest(options.format ?? "patch", binding.request.name, workspaceId),
            })
            .pipe(Effect.mapError(mapWorkspaceError));
          return { ...exported, orphan: false };
        }),
      );
    });
  return (
    workspaceId: string,
    options: WorkspaceExportOptions = {},
    caller = SUBAGENT_ROOT_RUN_ID,
  ): Effect.Effect<WorkspaceExportResult, SubagentError> =>
    Effect.suspend(() =>
      caller === SUBAGENT_ROOT_RUN_ID && !state.bindings.has(workspaceId)
        ? orphans
            .exportOrphan(
              workspaceId,
              options.revisionId,
              exportRequest(options.format ?? "patch", undefined, workspaceId),
            )
            .pipe(Effect.map(asOrphan))
        : exportOwned(workspaceId, options, caller),
    );
}
