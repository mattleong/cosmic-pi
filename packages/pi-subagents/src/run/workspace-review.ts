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

/** How long a settled writer's background process cleanup may take before a check gives up. */
const WRITER_CLEANUP_WAIT = "10 seconds";

/** Whether `abandon` completed or the caller was interrupted, even while it is uninterruptible. */
const abandoned = (abandon: Deferred.Deferred<void>): Effect.Effect<boolean> =>
  Deferred.isDone(abandon).pipe(
    Effect.flatMap((done) =>
      done
        ? Effect.succeed(true)
        : Effect.interruptible(Effect.void).pipe(Effect.exit, Effect.map(Exit.isFailure)),
    ),
  );

/**
 * Runs `wait` unless `abandon` completes or the caller is interrupted first, even while it is
 * uninterruptible; true once `wait` finished.
 */
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

/** A root operation's hold on its binding while the engine works outside the run lock. */
interface HeldBinding {
  readonly binding: WorkspaceBinding;
  /** Under the run lock: fails unless the hold is still intact. */
  readonly heldLocked: () => Effect.Effect<void, SubagentError>;
}

/**
 * Root review, preparation and discard of a settled writer's workspace, including the discard
 * of one that holds no work, which workflows use for their worktree writers. Each queues on the
 * coordinator's operation lock, holds its binding busy, and calls the engine outside the run
 * lock; only removing an unchanged worker's trees also holds the run lock. A review first
 * reopens an engine record whose revision a later assignment made stale.
 */
export function makeWorkspaceReview(context: WorkspaceControlContext) {
  const { withLock, state, records, requireBinding, requireEngine, operations, nextOperation } =
    context;
  /** Holds the caller's binding busy around `use`, under an operation permit already held. */
  const hold = <A>(
    workspaceId: string,
    caller: string,
    use: (held: HeldBinding) => Effect.Effect<A, SubagentError>,
  ): Effect.Effect<A, SubagentError> =>
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
    );
  /**
   * Runs one root operation on the caller's binding. Root operations queue on `operations`;
   * each holds its binding busy and calls the engine outside the run lock, so settlement, stops
   * and admissions never wait behind engine work such as a slow workspace create.
   */
  const operate = <A>(
    workspaceId: string,
    caller: string,
    use: (held: HeldBinding) => Effect.Effect<A, SubagentError>,
  ): Effect.Effect<A, SubagentError> => operations.withPermits(1)(hold(workspaceId, caller, use));
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
  /**
   * The cleanup a settled writer of the workspace still runs in the background, such as a
   * completed writer's process exit; undefined once confirmed or without a bound writer.
   */
  const pendingCleanup = (workspaceId: string) =>
    withLock(
      Effect.sync(() => {
        const record = state.bindings.get(workspaceId)?.record;
        return record && (record.cleanupPending || record.cleanupDisposition === "pending")
          ? record.cleanupSettlement
          : undefined;
      }),
    );
  /**
   * Takes an operation permit, waiting for one unless `abandon` completes or the caller is
   * interrupted first; false, holding none, once abandoned. The take itself is one synchronous
   * step, as in `withPermits`, so an abandoned wait never leaves a permit taken.
   */
  const takeOperation = (abandon: Deferred.Deferred<void>): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (yield* abandoned(abandon)) return false;
      if (yield* operations.takeIfAvailable(1)) return true;
      // Waits until a permit is free; another waiter may take it first, so this tries again.
      if (!(yield* awaitUnlessAbandoned(operations.withPermits(1)(Effect.void), abandon)))
        return false;
      return yield* takeOperation(abandon);
    });
  /**
   * Under the held binding: discards the workspace when the engine finds its worker unchanged
   * and no other run works, or worked meanwhile, inside its trees, such as a reader the writer
   * started, which outlives a writer that completed. The engine checks and discards under its
   * own lock, and the discard also holds the run lock, so no run starts inside the worker until
   * its trees are gone. This is the only operation that takes the run lock while holding the
   * engine's: its permit keeps integration, which takes them the other way, from running, and
   * its busy binding keeps mode checks from listing workspaces under the run lock.
   */
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
                // Failing here, after the check, the worker held nothing but may be partly gone.
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
  /**
   * Discards a settled writer's workspace only when it holds no work. It first waits a while for
   * the writer's background process cleanup; one still unconfirmed then fails like any other
   * operation, so the workspace is kept. Only its waits, for that cleanup and for its turn among
   * root operations, end early, with false, once `abandon` completes or the caller is
   * interrupted; a check already under way always finishes. True once discarded. A discard that
   * fails after the check fails with `workspace_discard_incomplete`.
   */
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
