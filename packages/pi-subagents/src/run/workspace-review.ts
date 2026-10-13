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
  readonly offset: number;
  readonly totalChars: number;
  readonly nextOffset?: number;
}

export interface WorkspaceReviewOptions {
  readonly revisionId?: string;
  readonly offset?: number;
  readonly limit?: number;
}

interface HeldBinding {
  readonly binding: WorkspaceBinding;
  readonly heldLocked: () => Effect.Effect<void, SubagentError>;
}

const engineRevision = (service: WorkspaceServiceContract, { handle }: WorkspaceBinding) =>
  service.list({ ownerId: handle.ownerId }).pipe(
    Effect.mapError(mapWorkspaceError),
    Effect.map(
      (entries) =>
        entries.find((entry) => entry.handle.workspaceId === handle.workspaceId)?.revision,
    ),
  );

export function makeWorkspaceReview(context: WorkspaceControlContext) {
  const { withLock, state, requireBinding, requireEngine, operations } = context;
  const hold = <A>(
    workspaceId: string,
    caller: string,
    use: (held: HeldBinding) => Effect.Effect<A, SubagentError>,
  ): Effect.Effect<A, SubagentError> =>
    Effect.acquireUseRelease(
      withLock(
        Effect.gen(function* () {
          const binding = yield* requireBinding(workspaceId, caller);
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
  ): Effect.Effect<A, SubagentError> => operations.withPermits(1)(hold(workspaceId, caller, use));
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
        const revision = yield* engineRevision(service, binding);
        if (binding.reopenPending || revision?.revisionId !== revisionId)
          return yield* invalid(
            "workspace_revision_stale",
            "The immutable workspace revision no longer matches.",
          );
        return revision;
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
          const revision = yield* engineRevision(service, binding);
          if (
            binding.reviewedRevision !== revisionId ||
            revision?.revisionId !== revisionId ||
            binding.reviewedThrough !== revision.diff.length
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
        Effect.gen(function* () {
          yield* service
            .discard({
              workspaceId,
              ownerId: binding.handle.ownerId,
              processCleanupConfirmed: true,
            })
            .pipe(Effect.mapError(mapWorkspaceError));
          yield* withLock(
            Effect.gen(function* () {
              yield* heldLocked();
              binding.finished = true;
            }),
          );
        }),
      );
    });
  return { workspaceReview, workspacePrepare, workspaceDiscard };
}
