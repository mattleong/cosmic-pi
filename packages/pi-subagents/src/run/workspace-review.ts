import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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

const WRITER_CLEANUP_WAIT = "10 seconds";

const abandoned = (abandon: Deferred.Deferred<void>): Effect.Effect<boolean> =>
  Deferred.isDone(abandon).pipe(
    Effect.flatMap((done) =>
      done
        ? Effect.succeed(true)
        : Effect.interruptible(Effect.void).pipe(Effect.exit, Effect.map(Exit.isFailure)),
    ),
  );

const awaitUnlessAbandoned = <A>(
  wait: Effect.Effect<A>,
  abandon: Deferred.Deferred<void>,
): Effect.Effect<boolean> =>
  Effect.interruptible(
    wait.pipe(Effect.as(true), Effect.raceFirst(Deferred.await(abandon).pipe(Effect.as(false)))),
  ).pipe(
    Effect.exit,
    Effect.map((exit) => Exit.isSuccess(exit) && exit.value),
  );

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
  const { withLock, state, records, requireBinding, requireEngine, operations } = context;
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
  const pendingCleanup = (workspaceId: string) =>
    withLock(
      Effect.sync(() => {
        const record = state.bindings.get(workspaceId)?.record;
        return record && (record.cleanupPending || record.cleanupDisposition === "pending")
          ? record.cleanupSettlement
          : undefined;
      }),
    );
  const takeOperation = (abandon: Deferred.Deferred<void>): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (yield* abandoned(abandon)) return false;
      if (yield* operations.takeIfAvailable(1)) return true;
      if (!(yield* awaitUnlessAbandoned(operations.withPermits(1)(Effect.void), abandon)))
        return false;
      return yield* takeOperation(abandon);
    });
  const discardIfUnchanged = (service: WorkspaceServiceContract, held: HeldBinding) =>
    Effect.gen(function* () {
      const { binding } = held;
      const trees = [binding.handle.cwd, ...(binding.record ? [binding.record.view.cwd] : [])];
      const before = yield* withLock(Effect.sync(() => runsWithin(records, trees, binding.record)));
      if ([...before.keys()].some(runHoldsCwd)) return false;
      return yield* service
        .discardUnchanged(
          {
            workspaceId: binding.handle.workspaceId,
            ownerId: binding.handle.ownerId,
            processCleanupConfirmed: true,
          },
          (discard) =>
            withLock(
              Effect.gen(function* () {
                yield* held.heldLocked();
                const after = runsWithin(records, trees, binding.record);
                if (
                  [...after.keys()].some(runHoldsCwd) ||
                  after.size !== before.size ||
                  [...after].some(([record, view]) => before.get(record) !== view)
                )
                  return false;
                yield* discard.pipe(
                  Effect.mapError((error) =>
                    invalid("workspace_discard_incomplete", error.message),
                  ),
                );
                binding.finished = true;
                return true;
              }),
            ),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "WorkspaceError" ? mapWorkspaceError(error) : error,
          ),
        );
    });
  const workspaceDiscardUnchanged = (
    workspaceId: string,
    abandon: Deferred.Deferred<void>,
    caller = SUBAGENT_ROOT_RUN_ID,
  ): Effect.Effect<boolean, SubagentError> =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const service = yield* requireEngine;
        const cleanup = yield* pendingCleanup(workspaceId);
        if (
          cleanup &&
          !(yield* awaitUnlessAbandoned(
            Deferred.await(cleanup).pipe(Effect.timeoutOption(WRITER_CLEANUP_WAIT)),
            abandon,
          ))
        )
          return false;
        if (!(yield* takeOperation(abandon))) return false;
        return yield* hold(workspaceId, caller, (held) => discardIfUnchanged(service, held)).pipe(
          Effect.ensuring(operations.release(1)),
        );
      }),
    );
  return { workspaceReview, workspacePrepare, workspaceDiscard, workspaceDiscardUnchanged };
}
