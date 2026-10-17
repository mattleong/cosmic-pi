import * as Effect from "effect/Effect";
import type {
  WorkspacePreparation,
  WorkspaceRevision,
  WorkspaceSettledTarget,
} from "../workspace/model.ts";
import type { WorkspaceServiceContract } from "../workspace/service.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import { SUBAGENT_ROOT_RUN_ID } from "./model.ts";
import {
  mapWorkspaceError,
  runHoldsCwd,
  runsWithin,
  workspaceArtifactDirectory,
  type WorkspaceAccess,
  type WorkspaceBinding,
  type WorkspaceControlContext,
} from "./workspace-binding.ts";
import { provisionWorkspaceTree } from "./workspace-setup.ts";

export interface WorkspaceReview extends WorkspaceRevision {
  readonly offset: number;
  readonly totalChars: number;
  readonly nextOffset?: number;
}

export interface WorkspaceReviewOptions {
  readonly revisionId?: string;
  readonly offset?: number;
  readonly limit?: number;
}

/** A binding this operation keeps busy; `heldLocked` confirms, under the run lock, it still does. */
export interface HeldBinding {
  readonly binding: WorkspaceBinding;
  readonly token: symbol;
  readonly heldLocked: () => Effect.Effect<void, SubagentError>;
}

const engineRecord = (service: WorkspaceServiceContract, { handle }: WorkspaceBinding) =>
  service
    .inspect({ workspaceId: handle.workspaceId, ownerId: handle.ownerId })
    .pipe(Effect.mapError(mapWorkspaceError));

export function workspaceReviewOperations(context: WorkspaceControlContext) {
  const { records, withLock, state, requireBinding, requireEngine, operations, workspaceSetup } =
    context;
  const { requireChildrenResolved } = context;
  /**
   * Marks the binding busy for `use`, so resume, revise, fork, and other operations refuse it. A
   * workspace that is the source of unresolved child workspaces is refused.
   */
  const hold = <A>(
    workspaceId: string,
    caller: string,
    use: (held: HeldBinding) => Effect.Effect<A, SubagentError>,
    access?: WorkspaceAccess,
  ): Effect.Effect<A, SubagentError> =>
    Effect.acquireUseRelease(
      withLock(
        Effect.gen(function* () {
          const binding = yield* requireBinding(workspaceId, caller, undefined, access);
          yield* requireChildrenResolved(binding);
          const token = Symbol("workspace operation");
          binding.busy = token;
          return {
            binding,
            heldLocked: () =>
              state.bindings.get(workspaceId) === binding && binding.busy === token
                ? Effect.void
                : Effect.fail(
                    invalid(
                      "workspace_owner_unavailable",
                      "Workspace ownership changed while the operation was running.",
                    ),
                  ),
            token,
          };
        }),
      ),
      use,
      ({ binding, token }) =>
        withLock(
          Effect.sync(() => {
            if (binding.busy === token) binding.busy = undefined;
          }),
        ),
    );
  const operate = <A>(
    workspaceId: string,
    caller: string,
    use: (held: HeldBinding) => Effect.Effect<A, SubagentError>,
    access?: WorkspaceAccess,
  ): Effect.Effect<A, SubagentError> =>
    operations.withPermits(1)(hold(workspaceId, caller, use, access));
  const reviewedRevision = (
    service: WorkspaceServiceContract,
    binding: WorkspaceBinding,
    revisionId: string | undefined,
  ): Effect.Effect<WorkspaceRevision, SubagentError> =>
    Effect.gen(function* () {
      const target: WorkspaceSettledTarget = {
        workspaceId: binding.handle.workspaceId,
        ownerId: binding.handle.ownerId,
        processCleanupConfirmed: true,
      };
      if (binding.reopenPending) {
        if (revisionId)
          return yield* invalid(
            "workspace_revision_stale",
            "The immutable workspace revision no longer matches.",
          );
        yield* service.revise(target).pipe(Effect.mapError(mapWorkspaceError));
        return yield* service.freeze(target).pipe(Effect.mapError(mapWorkspaceError));
      }
      const { status, revision } = yield* engineRecord(service, binding);
      if (revisionId) {
        if (revision?.revisionId !== revisionId)
          return yield* invalid(
            "workspace_revision_stale",
            "The immutable workspace revision no longer matches.",
          );
        return revision;
      }
      // The engine freezes only active workspaces; a frozen or prepared one keeps its revision.
      if (revision && (status === "frozen" || status === "prepared")) return revision;
      return yield* service.freeze(target).pipe(Effect.mapError(mapWorkspaceError));
    });
  /** Freezes or reuses the current revision; a freeze after resume or revision settles its reopen. */
  const settledRevision = (
    service: WorkspaceServiceContract,
    { binding, heldLocked }: HeldBinding,
    revisionId: string | undefined,
  ): Effect.Effect<WorkspaceRevision, SubagentError> =>
    Effect.gen(function* () {
      const reopened = binding.reopenPending === true && !revisionId;
      const revision = yield* reviewedRevision(service, binding, revisionId);
      yield* withLock(
        heldLocked().pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (reopened) binding.reopenPending = undefined;
            }),
          ),
        ),
      );
      return revision;
    });
  /**
   * Prepares the revision and provisions its tree. The preparation is untested until the caller
   * records it, after any verification it requires.
   */
  const prepareHeld = (
    service: WorkspaceServiceContract,
    { binding }: HeldBinding,
    revisionId: string,
  ): Effect.Effect<WorkspacePreparation, SubagentError> =>
    Effect.gen(function* () {
      // The engine replaces any earlier preparation, which is no longer tested from here on.
      yield* withLock(
        Effect.sync(() => {
          binding.testedPreparation = undefined;
          binding.verificationFailedPreparation = undefined;
        }),
      );
      const preparation = yield* service
        .prepare({
          workspaceId: binding.handle.workspaceId,
          ownerId: binding.handle.ownerId,
          revisionId,
        })
        .pipe(Effect.mapError(mapWorkspaceError));
      if (workspaceSetup)
        yield* provisionWorkspaceTree(
          service,
          workspaceSetup,
          binding.handle,
          preparation,
          (pending) => {
            binding.setupCleanupPending = pending;
          },
        );
      return preparation;
    });
  const markTested = ({ binding, heldLocked }: HeldBinding, preparation: WorkspacePreparation) =>
    withLock(
      heldLocked().pipe(
        Effect.andThen(
          Effect.sync(() => {
            binding.testedPreparation = preparation.preparationId;
          }),
        ),
      ),
    );
  /**
   * Like integration, destructive cleanup holds admission closed from the cwd check through
   * removal, so callers run this under the run lock. Natural writer completion does not stop its
   * read-only descendants.
   */
  const discardLocked = (
    service: WorkspaceServiceContract,
    binding: WorkspaceBinding,
  ): Effect.Effect<void, SubagentError> =>
    Effect.gen(function* () {
      const { workspaceId, ownerId } = binding.handle;
      const artifact = yield* service
        .inspect({ workspaceId, ownerId })
        .pipe(Effect.mapError(mapWorkspaceError));
      const directory = workspaceArtifactDirectory(artifact.handle);
      if (!directory)
        return yield* invalid(
          "workspace_owner_unavailable",
          "Workspace paths do not match the managed artifact layout.",
        );
      if ([...runsWithin(records, [directory]).keys()].some(runHoldsCwd))
        return yield* invalid(
          "workspace_process_unsettled",
          "A run still uses this workspace. Stop it and confirm cleanup before discard.",
        );
      yield* service
        .discard({ workspaceId, ownerId, processCleanupConfirmed: true })
        .pipe(Effect.mapError(mapWorkspaceError));
      binding.finished = true;
      return undefined;
    });
  const workspaceReview = (
    workspaceId: string,
    options: WorkspaceReviewOptions = {},
    caller = SUBAGENT_ROOT_RUN_ID,
  ): Effect.Effect<WorkspaceReview, SubagentError> =>
    Effect.gen(function* () {
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 16_000;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 16_000
      )
        return yield* invalid(
          "workspace_diff_bounds",
          "Diff offset must be a nonnegative integer and limit must be 1 through 16000.",
        );
      const service = yield* requireEngine;
      return yield* operate(workspaceId, caller, (held) =>
        Effect.gen(function* () {
          const { binding, heldLocked } = held;
          const revision = yield* settledRevision(service, held, options.revisionId);
          return yield* withLock(
            Effect.gen(function* () {
              yield* heldLocked();
              if (offset > revision.diff.length)
                return yield* invalid(
                  "workspace_diff_bounds",
                  "Diff offset exceeds this revision.",
                );
              const nextOffset = Math.min(revision.diff.length, offset + limit);
              if (binding.reviewedRevision !== revision.revisionId) {
                binding.reviewedRevision = revision.revisionId;
                binding.reviewedThrough = 0;
              }
              if (offset <= (binding.reviewedThrough ?? 0))
                binding.reviewedThrough = Math.max(binding.reviewedThrough ?? 0, nextOffset);
              return {
                ...revision,
                diff: revision.diff.slice(offset, nextOffset),
                offset,
                totalChars: revision.diff.length,
                ...(nextOffset < revision.diff.length && { nextOffset }),
              };
            }),
          );
        }),
      );
    });
  const workspacePrepare = (
    workspaceId: string,
    revisionId: string,
    caller = SUBAGENT_ROOT_RUN_ID,
  ): Effect.Effect<WorkspacePreparation, SubagentError> =>
    Effect.gen(function* () {
      const service = yield* requireEngine;
      return yield* operate(workspaceId, caller, (held) =>
        Effect.gen(function* () {
          const { binding } = held;
          const { revision } = yield* engineRecord(service, binding);
          if (
            binding.reviewedRevision !== revisionId ||
            revision?.revisionId !== revisionId ||
            binding.reviewedThrough !== revision.diff.length
          )
            return yield* invalid(
              "workspace_review_incomplete",
              "Read every page of this exact immutable revision before preparing integration.",
            );
          // The careful path leaves testing to the parent, so a configured verify does not run here.
          const preparation = yield* prepareHeld(service, held, revisionId);
          yield* markTested(held, preparation);
          return preparation;
        }),
      );
    });
  const workspaceDiscard = (
    workspaceId: string,
    caller = SUBAGENT_ROOT_RUN_ID,
  ): Effect.Effect<void, SubagentError> =>
    Effect.gen(function* () {
      const service = yield* requireEngine;
      // Once the direct parent is inactive, the root or its ancestors may discard, never integrate.
      yield* operate(
        workspaceId,
        caller,
        ({ binding, heldLocked }) =>
          withLock(heldLocked().pipe(Effect.andThen(discardLocked(service, binding)))),
        "discard",
      );
    });
  return {
    workspaceReview,
    workspacePrepare,
    workspaceDiscard,
    /** Phases a multi-step operation composes while it keeps one binding busy. */
    held: { hold, settledRevision, prepareHeld, discardLocked },
  };
}
