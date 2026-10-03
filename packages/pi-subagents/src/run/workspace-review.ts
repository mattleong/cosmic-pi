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
  type WorkspaceBinding,
  type WorkspaceControlContext,
} from "./workspace-binding.ts";

export interface WorkspaceReview extends WorkspaceRevision {
  readonly workspaceId: string;
  readonly offset: number;
  readonly totalChars: number;
  readonly nextOffset?: number;
}

export interface WorkspaceReviewOptions {
  readonly revisionId?: string;
  readonly offset?: number;
  readonly limit?: number;
}

/** A root operation's hold on its binding while the engine works outside the run lock. */
interface HeldBinding {
  readonly binding: WorkspaceBinding;
  /** Under the run lock: fails unless the hold is still intact. */
  readonly heldLocked: () => Effect.Effect<void, SubagentError>;
}

/**
 * Root review, preparation and discard of a settled writer's workspace. Each queues on the
 * coordinator's operation lock, holds its binding busy, and calls the engine outside the run
 * lock. A review first reopens an engine record whose revision a later assignment made stale.
 */
export function makeWorkspaceReview(context: WorkspaceControlContext) {
  const { withLock, state, requireBinding, requireEngine, operations, nextOperation } = context;
  /**
   * Runs one root operation on the caller's binding. Root operations queue on `operations`;
   * each holds its binding busy and calls the engine outside the run lock, so settlement, stops
   * and admissions never wait behind engine work such as a slow workspace create.
   */
  const operate = <A>(
    workspaceId: string,
    caller: string,
    use: (held: HeldBinding) => Effect.Effect<A, SubagentError>,
  ): Effect.Effect<A, SubagentError> =>
    operations.withPermits(1)(
      Effect.acquireUseRelease(
        withLock(
          Effect.gen(function* () {
            const binding = yield* requireBinding(workspaceId, caller);
            const token = nextOperation();
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
        ({ binding, heldLocked }) => use({ binding, heldLocked }),
        ({ binding, token }) =>
          withLock(
            Effect.sync(() => {
              if (binding.busy === token) binding.busy = undefined;
            }),
          ),
      ),
    );
  /** The revision a review reads: the named frozen one, or a fresh freeze of the worker. */
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
      if (revisionId) {
        const entry = (yield* service
          .list({ ownerId: target.ownerId })
          .pipe(Effect.mapError(mapWorkspaceError))).find(
          (entry) => entry.handle.workspaceId === target.workspaceId,
        );
        // A pending reopen makes the revision the engine still holds stale.
        if (binding.reopenPending || !entry?.revision || entry.revision.revisionId !== revisionId)
          return yield* invalid(
            "workspace_revision_stale",
            "The immutable workspace revision no longer matches.",
          );
        return entry.revision;
      }
      if (binding.reopenPending)
        yield* service.revise(target).pipe(Effect.mapError(mapWorkspaceError));
      return yield* service.freeze(target).pipe(Effect.mapError(mapWorkspaceError));
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
      return yield* operate(workspaceId, caller, ({ binding, heldLocked }) =>
        Effect.gen(function* () {
          const reopened = binding.reopenPending === true && !options.revisionId;
          const revision = yield* reviewedRevision(service, binding, options.revisionId);
          return yield* withLock(
            Effect.gen(function* () {
              yield* heldLocked();
              if (reopened) binding.reopenPending = undefined;
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
                workspaceId,
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
      return yield* operate(workspaceId, caller, ({ binding }) =>
        Effect.gen(function* () {
          const entry = (yield* service
            .list({ ownerId: binding.handle.ownerId })
            .pipe(Effect.mapError(mapWorkspaceError))).find(
            (entry) => entry.handle.workspaceId === workspaceId,
          );
          // A pending reopen also cleared the reviewed revision.
          if (
            binding.reviewedRevision !== revisionId ||
            !entry?.revision ||
            entry.revision.revisionId !== revisionId ||
            binding.reviewedThrough !== entry.revision.diff.length
          )
            return yield* invalid(
              "workspace_review_incomplete",
              "Read every page of this exact immutable revision before preparing integration.",
            );
          return yield* service
            .prepare({ workspaceId, ownerId: binding.handle.ownerId, revisionId })
            .pipe(Effect.mapError(mapWorkspaceError));
        }),
      );
    });
  const workspaceDiscard = (
    workspaceId: string,
    caller = SUBAGENT_ROOT_RUN_ID,
  ): Effect.Effect<void, SubagentError> =>
    Effect.gen(function* () {
      const service = yield* requireEngine;
      yield* operate(workspaceId, caller, ({ binding, heldLocked }) =>
        service
          .discard({ workspaceId, ownerId: binding.handle.ownerId, processCleanupConfirmed: true })
          .pipe(
            Effect.mapError(mapWorkspaceError),
            Effect.andThen(
              withLock(
                heldLocked().pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      binding.finished = true;
                    }),
                  ),
                ),
              ),
            ),
          ),
      );
    });
  return { workspaceReview, workspacePrepare, workspaceDiscard };
}
