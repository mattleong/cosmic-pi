import * as Effect from "effect/Effect";
import type { WriterWorkspaceMode } from "../config/schema.ts";
import type {
  WorkspaceListing,
  WorkspacePreparation,
  WorkspaceRecord,
} from "../workspace/model.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import { isActiveRunState, SUBAGENT_ROOT_RUN_ID, type SubagentRunView } from "./model.ts";
import {
  isWithin,
  workspaceControlContext,
  mapWorkspaceError,
  type WorkspaceControlDependencies,
} from "./workspace-binding.ts";
import {
  workspaceIntegrationOperations,
  type WorkspaceIntegrationOutcome,
} from "./workspace-integration.ts";
import { workspaceLaunchOperations } from "./workspace-launch.ts";
import { workspaceOrphanOperations } from "./workspace-orphan.ts";
import {
  workspaceReviewOperations,
  type WorkspaceReview,
  type WorkspaceReviewOptions,
} from "./workspace-review.ts";

export type WriterWorkspaceBlockCode =
  | "writers-active"
  | "records-unavailable"
  | "unresolved-workspace";

interface WorkspaceBlock {
  readonly code: WriterWorkspaceBlockCode;
  readonly reason: string;
}

export interface WriterWorkspaceInspection {
  readonly mode: WriterWorkspaceMode;
  readonly blockedReason?: string;
  readonly blockedCode?: WriterWorkspaceBlockCode;
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
  ) => Effect.Effect<WorkspacePreparation, SubagentError>;
  readonly workspaceIntegrate: (
    workspaceId: string,
    revisionId: string,
    preparationId: string,
    callerRunId?: string,
  ) => Effect.Effect<WorkspaceIntegrationOutcome, SubagentError>;
  readonly workspaceDiscard: (
    workspaceId: string,
    callerRunId?: string,
  ) => Effect.Effect<void, SubagentError>;
  readonly workspaceRevise: (
    workspaceId: string,
    message: string,
    callerRunId?: string,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly inspectWriterWorkspace: Effect.Effect<WriterWorkspaceInspection, SubagentError>;
  readonly setWriterWorkspaceMode: <A, E, R>(
    mode: WriterWorkspaceMode,
    persist: Effect.Effect<A, E, R>,
  ) => Effect.Effect<void, SubagentError | E, R>;
}

export function workspaceControl(dependencies: WorkspaceControlDependencies) {
  const context = workspaceControlContext(dependencies);
  const { engine, ownerId, records, writerPools, withLock, isClosed, state, ownerFor } = context;
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
        records: entries.filter(
          (record) =>
            owned(record) || (source !== undefined && isWithin(source, record.handle.sourceRoot)),
        ),
      };
    });
  const workspaceBlock = (): Effect.Effect<WorkspaceBlock | undefined, SubagentError> =>
    Effect.gen(function* () {
      if (
        state.integrationQuarantined ||
        state.reservations > 0 ||
        [...records.values()].some(
          (record) =>
            record.view.writeIntent === "writer" &&
            (isActiveRunState(record.view.state) ||
              record.cleanupPending ||
              record.cleanupDisposition === "quarantined" ||
              record.evictionClaim !== undefined),
        ) ||
        writerPools.size > 0
      )
        return {
          code: "writers-active",
          reason: "Writers, admission reservations, or quarantined writer ownership remain.",
        };
      const busy = [...state.bindings.values()].find((binding) => binding.busy !== undefined);
      if (busy)
        return {
          code: "unresolved-workspace",
          reason: `Workspace ${busy.handle.workspaceId} has an operation in progress. Retry once it finishes.`,
        };
      const listing: WorkspaceListing = engine
        ? yield* engine.listAll.pipe(Effect.mapError(mapWorkspaceError))
        : { records: [], unavailable: [] };
      if (listing.unavailable.length > 0)
        return {
          code: "records-unavailable",
          reason:
            "Workspace recovery metadata is unavailable. Ownership, source identity, and cleanup are unknown; preserve the artifacts and resolve them manually before changing workspace mode.",
        };
      const pending = (yield* sourceRecords(listing)).records.find(
        (record) => record.status !== "integrated" && record.status !== "discarded",
      );
      if (pending)
        return {
          code: "unresolved-workspace",
          reason: `Unresolved workspace ${pending.handle.workspaceId} remains at ${pending.handle.cwd}. Inspect subagent_workspace list. If the session that created it has ended, recover anything you need from its directory, then subagent_workspace discard deletes it once no writer holds it. Otherwise preserve the directory until that session integrates or discards it.`,
        };
      return undefined;
    });
  const inspectWriterWorkspace = withLock(
    Effect.gen(function* () {
      const block = yield* workspaceBlock();
      return {
        mode: state.mode,
        ...(block && { blockedReason: block.reason, blockedCode: block.code }),
      };
    }),
  );
  const setWriterWorkspaceMode: WorkspaceCoordinatorContract["setWriterWorkspaceMode"] = (
    next,
    persist,
  ) =>
    withLock(
      Effect.gen(function* () {
        if (isClosed())
          return yield* invalid("workspace_runtime_closed", "The subagent session is closed.");
        const block = yield* workspaceBlock();
        if (block) return yield* invalid("workspace_mode_busy", block.reason);
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
  const currentRecord = (record: WorkspaceRecord): WorkspaceRecord =>
    state.bindings.get(record.handle.workspaceId)?.reopenPending &&
    (record.status === "frozen" || record.status === "prepared")
      ? {
          version: record.version,
          handle: record.handle,
          status: "active",
          baseline: record.baseline,
          ...(record.predecessorWorkspaceId !== undefined && {
            predecessorWorkspaceId: record.predecessorWorkspaceId,
          }),
          ...(record.excludedPaths !== undefined && { excludedPaths: record.excludedPaths }),
        }
      : record;
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
  const discardOrphan = workspaceOrphanOperations(context, sourceRecords);
  // The root may discard a workspace no live binding owns once its creating session has ended.
  const workspaceDiscard: WorkspaceCoordinatorContract["workspaceDiscard"] = (
    workspaceId,
    caller = SUBAGENT_ROOT_RUN_ID,
  ) =>
    Effect.suspend(() =>
      caller === SUBAGENT_ROOT_RUN_ID && !state.bindings.has(workspaceId)
        ? discardOrphan(workspaceId)
        : review.workspaceDiscard(workspaceId, caller),
    );
  return {
    ...workspaceLaunchOperations(context),
    ...review,
    workspaceDiscard,
    workspaceIntegrate: workspaceIntegrationOperations(context),
    workspaceList,
    inspectWriterWorkspace,
    setWriterWorkspaceMode,
  };
}

export type RunWorkspaceControl = ReturnType<typeof workspaceControl>;
