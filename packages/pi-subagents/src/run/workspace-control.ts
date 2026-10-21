import * as Effect from "effect/Effect";
import type { WriterWorkspaceMode } from "../config/schema.ts";
import type { WorkspaceListing, WorkspaceRecord, WorkspaceSwept } from "../workspace/model.ts";
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
import { workspaceIntegrationOperations } from "./workspace-integration.ts";
import {
  workspaceLaunchOperations,
  type WorkspaceReviseOptions,
  type WorkspaceRevised,
} from "./workspace-launch.ts";
import {
  type OrphanDisposition,
  orphanDisposition,
  workspaceOrphanOperations,
} from "./workspace-orphan.ts";
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

interface WorkspaceCoordinatorListing extends WorkspaceListing {
  /** The root's listing marks other sessions' workspaces it may adopt or only discard. */
  readonly orphans?: ReadonlyMap<string, OrphanDisposition> | undefined;
}

export interface WorkspaceCoordinatorContract {
  readonly workspaceList: (
    callerRunId?: string,
  ) => Effect.Effect<WorkspaceCoordinatorListing, SubagentError>;
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
   * The direct parent's integration. Without a preparation it freezes, prepares, and integrates
   * in one step, without requiring the diff to be read; `paths` integrates only those changes and
   * keeps the rest as the workspace's proposal. With a preparation it integrates exactly that
   * reviewed and prepared pair.
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
  /** Starts a successor writer; `rebase` first rebuilds its tree from current parent files. */
  readonly workspaceRevise: (
    workspaceId: string,
    message: string,
    callerRunId?: string,
    options?: WorkspaceReviseOptions,
  ) => Effect.Effect<WorkspaceRevised, SubagentError>;
  readonly inspectWriterWorkspace: Effect.Effect<WriterWorkspaceInspection, SubagentError>;
  /**
   * Discards this checkout's orphans unchanged for 30 days, keeping each one's revision patch
   * until collection; the root runs it once at session start.
   */
  readonly sweepOrphanedWorkspaces: Effect.Effect<ReadonlyArray<WorkspaceSwept>, SubagentError>;
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
        endedOwners: listing.endedOwners,
        records: entries.filter(
          (record) =>
            owned(record) || (source !== undefined && isWithin(source, record.handle.sourceRoot)),
        ),
      };
    });
  // A count needs no orphan verdicts, so it never probes other sessions' owner leases.
  const unresolvedWorkspaceCount = Effect.gen(function* () {
    if (!engine) return 0;
    const listing = yield* engine.listRecords.pipe(Effect.mapError(mapWorkspaceError));
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
        repository: record.repository,
        status: "active",
        baseline: record.baseline,
        ownerLease: record.ownerLease,
        lastChangedAt: record.lastChangedAt,
      };
    // A preparation whose WorktreeCreate hooks failed or are still running cannot be integrated.
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
      const listing: WorkspaceCoordinatorListing =
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
        Effect.sync(() => {
          const orphans = new Map(
            caller === SUBAGENT_ROOT_RUN_ID
              ? listing.records.flatMap((record) => {
                  const { workspaceId } = record.handle;
                  const disposition = state.bindings.has(workspaceId)
                    ? undefined
                    : orphanDisposition(record, listing);
                  return disposition ? [[workspaceId, disposition] as const] : [];
                })
              : [],
          );
          return {
            ...listing,
            records: listing.records.map(currentRecord),
            ...(orphans.size > 0 && { orphans }),
          };
        }),
      );
    });
  const review = workspaceReviewOperations(context, dependencies.publish);
  const integrateLocked = workspaceIntegrationOperations(context, dependencies.publish);
  const orphans = workspaceOrphanOperations(context, sourceRecords);
  const isOrphan = (workspaceId: string, caller: string) =>
    caller === SUBAGENT_ROOT_RUN_ID && !state.bindings.has(workspaceId);
  /**
   * The root takes over a workspace no live binding owns, once its creating session has ended,
   * before the operation runs as on its own.
   */
  const adopting = <A>(
    workspaceId: string,
    caller: string,
    operation: Effect.Effect<A, SubagentError>,
  ): Effect.Effect<A, SubagentError> =>
    Effect.suspend(() =>
      isOrphan(workspaceId, caller)
        ? orphans.adopt(workspaceId).pipe(Effect.andThen(operation))
        : context.awaitWriterCleanup(workspaceId).pipe(Effect.andThen(operation)),
    );
  // An orphan is discarded without adoption, so mid-integration orphans can go too.
  const workspaceDiscard: WorkspaceCoordinatorContract["workspaceDiscard"] = (
    workspaceId,
    caller = SUBAGENT_ROOT_RUN_ID,
  ) =>
    Effect.suspend(() =>
      isOrphan(workspaceId, caller)
        ? orphans.discardOrphan(workspaceId)
        : context
            .awaitWriterCleanup(workspaceId)
            .pipe(Effect.andThen(review.workspaceDiscard(workspaceId, caller))),
    );
  const launch = workspaceLaunchOperations(context);
  const apply = workspaceApplyOperations(context, review.held, integrateLocked);
  return {
    ...launch,
    revise:
      (start: Parameters<typeof launch.revise>[0]) =>
      (...args: Parameters<ReturnType<typeof launch.revise>>) =>
        adopting(args[0], args[2] ?? SUBAGENT_ROOT_RUN_ID, launch.revise(start)(...args)),
    workspaceReview: (...args: Parameters<typeof review.workspaceReview>) =>
      adopting(args[0], args[2] ?? SUBAGENT_ROOT_RUN_ID, review.workspaceReview(...args)),
    workspacePrepare: (...args: Parameters<typeof review.workspacePrepare>) =>
      adopting(args[0], args[2] ?? SUBAGENT_ROOT_RUN_ID, review.workspacePrepare(...args)),
    workspaceDiscard,
    workspaceApply: (...args: Parameters<typeof apply>) =>
      adopting(args[0], args[2] ?? SUBAGENT_ROOT_RUN_ID, apply(...args)),
    sweepOrphanedWorkspaces: orphans.sweepOrphans,
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
