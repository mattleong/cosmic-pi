import type * as Deferred from "effect/Deferred";
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
  makeWorkspaceControlContext,
  mapWorkspaceError,
  type WorkspaceBindingStatus,
  type WorkspaceControlDependencies,
} from "./workspace-binding.ts";
import {
  makeWorkspaceIntegrate,
  type WorkspaceIntegrationOutcome,
} from "./workspace-integration.ts";
import { makeWorkspaceLaunch } from "./workspace-launch.ts";
import {
  makeWorkspaceReview,
  type WorkspaceReview,
  type WorkspaceReviewOptions,
} from "./workspace-review.ts";

/** Why the writer workspace mode cannot change right now. */
export type WriterWorkspaceBlockCode =
  | "writers-active"
  | "records-unavailable"
  | "unresolved-workspace";

interface WorkspaceBlock {
  readonly code: WriterWorkspaceBlockCode;
  /** Agent-facing explanation, which may name workspaces and paths. */
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
  /**
   * Discards a settled writer's workspace only when it holds no work: no change against its
   * baseline, no other file in its tree, and no other run working inside it. Waits a while for
   * the writer's process cleanup first. True once discarded; false, keeping the workspace, when
   * it holds work or once `abandon` completes or the caller is interrupted before the check
   * starts. A discard failing after the check fails with `workspace_discard_incomplete`.
   */
  readonly workspaceDiscardUnchanged: (
    workspaceId: string,
    abandon: Deferred.Deferred<void>,
    callerRunId?: string,
  ) => Effect.Effect<boolean, SubagentError>;
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

/**
 * Owns writer workspaces for one session: mode admission, listing, and composition of launch
 * (`workspace-launch.ts`), review, preparation and discard (`workspace-review.ts`), and
 * integration (`workspace-integration.ts`).
 * Artifacts deliberately outlive terminal-history entries and backend scopes.
 */
export function makeWorkspaceControl(dependencies: WorkspaceControlDependencies) {
  const context = makeWorkspaceControlContext(dependencies);
  const { engine, ownerId, records, writerPools, withLock, isClosed, state, ownerFor } = context;
  const { requireEngine, sourceCwd, writerLeases } = context;
  const sourceRecords = (listing: WorkspaceListing) =>
    Effect.gen(function* () {
      const entries = listing.records;
      const owned = (record: WorkspaceRecord) => record.handle.ownerId.startsWith(`${ownerId}/`);
      // Resolve aliases only when inspecting foreign artifacts, never during reader startup.
      const source =
        sourceCwd !== undefined && entries.some((record) => !owned(record))
          ? (yield* writerLeases.canonicalize(sourceCwd).pipe(Effect.mapError(mapWorkspaceError)))
              .path
          : undefined;
      return {
        // Unknown source identity cannot justify hiding an artifact from the root.
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
      // A root operation is using the engine; listing here would hold the run lock behind it.
      const busy = [...state.bindings.values()].find((binding) => binding.busy !== undefined);
      if (busy)
        return {
          code: "unresolved-workspace",
          reason: `Workspace ${busy.handle.workspaceId} has an operation in progress. Retry once it finishes.`,
        };
      // Unknown previous-session artifacts are not evidence of process death. Never silently adopt them.
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
          reason: `Unresolved workspace ${pending.handle.workspaceId} remains at ${pending.handle.cwd}. Inspect subagent_workspace list. If its original coordinator is unavailable, preserve the directory, independently confirm every old writer process is stopped, and recover its diff manually; this session cannot attest cleanup or delete it.`,
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
        // Admission stays locked through the durable preference commit and mode publication.
        // Cancellation cannot split persisted and current-session mode after the save commits.
        yield* Effect.uninterruptible(
          persist.pipe(
            Effect.andThen(
              Effect.sync(() => {
                state.mode = next;
              }),
            ),
          ),
        );
      }),
    );
  /** What the engine record becomes once a pending reopen runs: the stale review is gone. */
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
  return {
    ...makeWorkspaceLaunch(context),
    ...makeWorkspaceReview(context),
    workspaceIntegrate: makeWorkspaceIntegrate(context),
    workspaceList,
    inspectWriterWorkspace,
    setWriterWorkspaceMode,
    workspaceBindingStatus: (workspaceId: string) =>
      withLock(
        Effect.sync((): WorkspaceBindingStatus => {
          const binding = state.bindings.get(workspaceId);
          if (!binding) return "unbound";
          if (!binding.finished) return "pending";
          return binding.integrated ? "integrated" : "closed";
        }),
      ),
  };
}

export type RunWorkspaceControl = ReturnType<typeof makeWorkspaceControl>;
