import * as Effect from "effect/Effect";
import type { WriterWorkspaceMode } from "../config/schema.ts";
import {
  type WorkspaceListing,
  type WorkspaceRecord,
  workspaceCheckoutRoot,
} from "../workspace/model.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import type { RunContext } from "./internal.ts";
import { SUBAGENT_ROOT_RUN_ID } from "./model.ts";
import {
  isWithin,
  revisionKnowledge,
  workspaceControlContext,
  mapWorkspaceError,
  type WorkspaceControlDependencies,
} from "./workspace-binding.ts";
import {
  workspaceApplyOperations,
  type WorkspaceApplyOptions,
  type WorkspaceApplyResult,
} from "./workspace-apply.ts";
import {
  workspaceExportOperations,
  type WorkspaceExportOptions,
  type WorkspaceExportResult,
} from "./workspace-export.ts";
import { workspaceIntegrationOperations } from "./workspace-integration.ts";
import {
  workspaceLaunchOperations,
  type WorkspaceReviseOptions,
  type WorkspaceRevised,
} from "./workspace-launch.ts";
import { workspaceOrphanOperations } from "./workspace-orphan.ts";
import {
  workspaceReviewOperations,
  type WorkspacePrepared,
  type WorkspaceReview,
  type WorkspaceReviewOptions,
} from "./workspace-review.ts";
import { workspaceSettleOperations } from "./workspace-settle.ts";

export interface WriterWorkspaceInspection {
  /** The default for writers whose start item doesn't set isolation. */
  readonly mode: WriterWorkspaceMode;
  /** Present when this checkout still has workspaces that are neither integrated nor discarded. */
  readonly unresolvedWorkspaceCount?: number;
}

export interface WorkspaceCoordinatorContract {
  readonly workspaceList: (callerRunId?: string) => Effect.Effect<WorkspaceListing, SubagentError>;
  readonly workspaceReview: (
    workspaceId: string,
    options?: WorkspaceReviewOptions,
    callerRunId?: string,
  ) => Effect.Effect<WorkspaceReview, SubagentError>;
  readonly workspacePrepare: (
    workspaceId: string,
    revisionId: string,
    callerRunId?: string,
  ) => Effect.Effect<WorkspacePrepared, SubagentError>;
  /**
   * The direct parent's integration. Without a preparation it freezes, prepares, verifies, and
   * integrates in one step, without requiring the diff to be read, and a failed verification
   * integrates nothing; `paths` integrates only those changes and keeps the rest as the
   * workspace's proposal. With a preparation it integrates exactly that reviewed and prepared
   * pair.
   */
  readonly workspaceApply: (
    workspaceId: string,
    options?: WorkspaceApplyOptions,
    callerRunId?: string,
  ) => Effect.Effect<WorkspaceApplyResult, SubagentError>;
  readonly workspaceDiscard: (
    workspaceId: string,
    callerRunId?: string,
  ) => Effect.Effect<void, SubagentError>;
  /**
   * Writes the proposal out as a patch file or branch in the source repository without resolving
   * it. The root may also export an orphan whose session has ended.
   */
  readonly workspaceExport: (
    workspaceId: string,
    options?: WorkspaceExportOptions,
    callerRunId?: string,
  ) => Effect.Effect<WorkspaceExportResult, SubagentError>;
  /** Starts a successor writer; `rebase` first rebuilds its tree from current parent files. */
  readonly workspaceRevise: (
    workspaceId: string,
    message: string,
    callerRunId?: string,
    options?: WorkspaceReviseOptions,
  ) => Effect.Effect<WorkspaceRevised, SubagentError>;
  readonly inspectWriterWorkspace: Effect.Effect<WriterWorkspaceInspection, SubagentError>;
  readonly setWriterWorkspaceMode: <A, E, R>(
    mode: WriterWorkspaceMode,
    persist: Effect.Effect<A, E, R>,
  ) => Effect.Effect<void, SubagentError | E, R>;
}

export function workspaceControl(
  dependencies: WorkspaceControlDependencies & Pick<RunContext, "publish">,
) {
  const context = workspaceControlContext(dependencies);
  const { engine, ownerId, withLock, isClosed, state, ownerFor } = context;
  const { requireEngine, sourceCwd, writerLeases } = context;
  const sourceRecords = (listing: WorkspaceListing) =>
    Effect.gen(function* () {
      const entries = listing.records;
      const owned = (record: WorkspaceRecord) => record.handle.ownerId.startsWith(`${ownerId}/`);
      const source =
        sourceCwd !== undefined && entries.some((record) => !owned(record))
          ? (yield* writerLeases.canonicalize(sourceCwd).pipe(Effect.mapError(mapWorkspaceError)))
              .path
          : undefined;
      return {
        unavailable: listing.unavailable,
        // A nested workspace belongs to the real checkout at the top of its chain.
        records: entries.filter(
          (record) =>
            owned(record) ||
            (source !== undefined && isWithin(source, workspaceCheckoutRoot(record.handle))),
        ),
      };
    });
  const unresolvedWorkspaceCount = Effect.gen(function* () {
    if (!engine) return 0;
    const listing = yield* engine.listAll.pipe(Effect.mapError(mapWorkspaceError));
    return (yield* sourceRecords(listing)).records.filter(
      (record) => record.status !== "integrated" && record.status !== "discarded",
    ).length;
  });
  // Informational only: unreadable recovery records leave the count out instead of failing.
  const inspectWriterWorkspace: Effect.Effect<WriterWorkspaceInspection, SubagentError> =
    Effect.gen(function* () {
      const mode = yield* Effect.sync(() => state.mode);
      const unresolved = yield* unresolvedWorkspaceCount.pipe(Effect.orElseSucceed(() => 0));
      return { mode, ...(unresolved > 0 && { unresolvedWorkspaceCount: unresolved }) };
    });
  // The mode is a default for later launches; existing runs and workspaces keep their own.
  const setWriterWorkspaceMode: WorkspaceCoordinatorContract["setWriterWorkspaceMode"] = (
    next,
    persist,
  ) =>
    withLock(
      Effect.gen(function* () {
        if (isClosed())
          return yield* invalid("workspace_runtime_closed", "The subagent session is closed.");
        yield* Effect.uninterruptible(
          persist.pipe(
            Effect.andThen(
              Effect.sync(() => {
                state.mode = next;
              }),
            ),
          ),
        );
        return undefined;
      }),
    );
  const currentRecord = (record: WorkspaceRecord): WorkspaceRecord => {
    const binding = state.bindings.get(record.handle.workspaceId);
    const knowledge = binding && revisionKnowledge(binding);
    if (
      knowledge?.kind === "reopened" &&
      (record.status === "frozen" || record.status === "prepared")
    )
      return {
        version: record.version,
        handle: record.handle,
        status: "active",
        baseline: record.baseline,
        ...(record.excludedPaths !== undefined && { excludedPaths: record.excludedPaths }),
      };
    // A preparation whose setup failed or is still running cannot be integrated. One that
    // failed verification stays listed for inspection, and integration refuses it.
    if (
      knowledge &&
      record.status === "prepared" &&
      !(
        knowledge.kind === "prepared" &&
        knowledge.preparationId === record.preparation?.preparationId
      )
    ) {
      const { preparation: _preparation, preparedTree: _preparedTree, ...frozen } = record;
      return { ...frozen, status: "frozen" };
    }
    return record;
  };
  const workspaceList: WorkspaceCoordinatorContract["workspaceList"] = (
    caller = SUBAGENT_ROOT_RUN_ID,
  ) =>
    Effect.gen(function* () {
      const service = yield* requireEngine;
      const listing: WorkspaceListing =
        caller === SUBAGENT_ROOT_RUN_ID
          ? yield* service.listAll.pipe(
              Effect.mapError(mapWorkspaceError),
              Effect.flatMap(sourceRecords),
            )
          : {
              records: yield* service
                .list({ ownerId: ownerFor(caller) })
                .pipe(Effect.mapError(mapWorkspaceError)),
              unavailable: [],
            };
      return yield* withLock(
        Effect.sync(() => ({ ...listing, records: listing.records.map(currentRecord) })),
      );
    });
  const review = workspaceReviewOperations(context);
  const integrateLocked = workspaceIntegrationOperations(context);
  const orphans = workspaceOrphanOperations(context, sourceRecords);
  // The root may discard a workspace no live binding owns once its creating session has ended.
  const workspaceDiscard: WorkspaceCoordinatorContract["workspaceDiscard"] = (
    workspaceId,
    caller = SUBAGENT_ROOT_RUN_ID,
  ) =>
    Effect.suspend(() =>
      caller === SUBAGENT_ROOT_RUN_ID && !state.bindings.has(workspaceId)
        ? orphans.discardOrphan(workspaceId)
        : review.workspaceDiscard(workspaceId, caller),
    );
  return {
    ...workspaceLaunchOperations(context),
    workspaceReview: review.workspaceReview,
    workspacePrepare: review.workspacePrepare,
    workspaceDiscard,
    workspaceExport: workspaceExportOperations(context, review.held, orphans),
    workspaceApply: workspaceApplyOperations(context, review.held, integrateLocked),
    /** Forked once a worktree writer completes; see `workspaceSettleOperations`. */
    settleCompletedWorkspace: workspaceSettleOperations(
      context,
      dependencies.publish,
      review.held.discardLocked,
    ),
    workspaceList,
    inspectWriterWorkspace,
    setWriterWorkspaceMode,
  };
}

export type RunWorkspaceControl = ReturnType<typeof workspaceControl>;
