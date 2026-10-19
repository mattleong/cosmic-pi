import * as Effect from "effect/Effect";
import { revisionSummary } from "../workspace/diffstat.ts";
import type {
  WorkspacePreparation,
  WorkspaceRevision,
  WorkspaceRevisionMetadata,
  WorkspaceSettledTarget,
} from "../workspace/model.ts";
import type { WorkspaceServiceContract } from "../workspace/service.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import { SUBAGENT_ROOT_RUN_ID } from "./model.ts";
import {
  mapWorkspaceError,
  type ReviewProgress,
  type RevisionKnowledge,
  revisionKnowledge,
  reviewProgress,
  runHoldsCwd,
  runsWithin,
  recordWorkspaceOutcomeLocked,
  settleBinding,
  settledState,
  updateKnowledge,
  workspaceArtifactDirectory,
  type WorkspaceAccess,
  type WorkspaceBinding,
  workspaceBusyError,
  type WorkspaceControlContext,
} from "./workspace-binding.ts";
import { runWorktreeCreateHooks } from "./workspace-hooks.ts";

/**
 * One page of a revision's review text: its summary followed by its patch. `text` is the page;
 * offsets index the whole text, which is deterministic for the revision.
 */
export interface WorkspaceReview extends WorkspaceRevisionMetadata {
  readonly text: string;
  readonly offset: number;
  readonly totalChars: number;
  readonly nextOffset?: number;
}

/** The text review pages: the revision's summary, then its patch. */
export const revisionReviewText = (revision: WorkspaceRevision) =>
  `${revisionSummary(revision)}${revision.diff}`;

export interface WorkspacePrepared extends WorkspacePreparation {
  /** Credential files the worker created, which the revision leaves out on purpose. */
  readonly leftOutPaths: ReadonlyArray<string>;
}

export interface WorkspaceReviewOptions {
  readonly revisionId?: string;
  readonly offset?: number;
  readonly limit?: number;
}

/** A binding this operation keeps busy; `heldLocked` confirms, under the run lock, it still does. */
interface HeldBinding {
  readonly binding: WorkspaceBinding;
  readonly token: symbol;
  readonly heldLocked: () => Effect.Effect<void, SubagentError>;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Where a page starting at `offset` ends: at most `limit` UTF-16 units, never between the two
 * halves of a character, unless that character alone is longer than the limit.
 */
const pageEnd = (text: string, offset: number, limit: number) => {
  const end = Math.min(text.length, offset + limit);
  if (
    end >= text.length ||
    !isHighSurrogate(text.charCodeAt(end - 1)) ||
    !isLowSurrogate(text.charCodeAt(end))
  )
    return end;
  return end - 1 > offset ? end - 1 : end + 1;
};

const engineRecord = (service: WorkspaceServiceContract, { handle }: WorkspaceBinding) =>
  service
    .inspect({ workspaceId: handle.workspaceId, ownerId: handle.ownerId })
    .pipe(Effect.mapError(mapWorkspaceError));

const staleRevision = () =>
  invalid("workspace_revision_stale", "The immutable workspace revision no longer matches.");

const engineRevision = (service: WorkspaceServiceContract, { handle }: WorkspaceBinding) =>
  service.revision({ workspaceId: handle.workspaceId, ownerId: handle.ownerId }).pipe(
    Effect.mapError(mapWorkspaceError),
    Effect.filterOrFail(
      (revision): revision is WorkspaceRevision => revision !== undefined,
      staleRevision,
    ),
  );

/** Records that the parent read the review text of `revisionId` from `offset` up to `nextOffset`. */
const readThrough = (
  knowledge: RevisionKnowledge,
  revisionId: string,
  totalChars: number,
  offset: number,
  nextOffset: number,
): RevisionKnowledge => {
  const known = reviewProgress(knowledge);
  const base: ReviewProgress =
    known?.revisionId === revisionId ? known : { revisionId, reviewedThrough: 0, totalChars };
  const review =
    offset <= base.reviewedThrough
      ? { ...base, reviewedThrough: Math.max(base.reviewedThrough, nextOffset) }
      : base;
  return knowledge.kind === "prepared" && knowledge.revisionId === revisionId
    ? { ...knowledge, review }
    : { kind: "frozen", review };
};

/** Every page of `revisionId` was read. */
export const fullyReviewed = (knowledge: RevisionKnowledge | undefined, revisionId: string) => {
  const review = reviewProgress(knowledge);
  return review?.revisionId === revisionId && review.reviewedThrough === review.totalChars;
};

/** The engine replaces any earlier preparation, which is no longer integrable from here on. */
const withoutPreparation = (knowledge: RevisionKnowledge): RevisionKnowledge =>
  knowledge.kind !== "prepared"
    ? knowledge
    : knowledge.review
      ? { kind: "frozen", review: knowledge.review }
      : { kind: "unreviewed" };

/** Records a ready preparation, which makes it integrable. */
const withPreparation =
  (preparation: WorkspacePreparation, origin: "prepare" | "apply") =>
  (knowledge: RevisionKnowledge): RevisionKnowledge => {
    const review = reviewProgress(knowledge);
    return {
      kind: "prepared",
      revisionId: preparation.revisionId,
      preparationId: preparation.preparationId,
      origin,
      ...(review?.revisionId === preparation.revisionId && { review }),
    };
  };

export function workspaceReviewOperations(
  context: WorkspaceControlContext,
  publish: Effect.Effect<void>,
) {
  const { records, withLock, state, requireBinding, requireEngine, operations, worktreeCreate } =
    context;
  const { requireChildrenResolved } = context;
  /**
   * Marks the binding busy for `use`, so resume, revise, and other operations refuse it. A
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
          const settled = settledState(binding);
          if (!settled) return yield* workspaceBusyError();
          const token = Symbol("workspace operation");
          binding.state = { phase: "busy", token, settled };
          const holds = () => binding.state.phase === "busy" && binding.state.token === token;
          return {
            binding,
            heldLocked: () =>
              state.bindings.get(workspaceId) === binding && holds()
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
            const { state: current } = binding;
            if (current.phase === "busy" && current.token === token)
              binding.state = current.settled;
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
      if (revisionKnowledge(binding)?.kind === "reopened") {
        if (revisionId) return yield* staleRevision();
        yield* service.revise(target).pipe(Effect.mapError(mapWorkspaceError));
        return yield* service.freeze(target).pipe(Effect.mapError(mapWorkspaceError));
      }
      const { status, revision } = yield* engineRecord(service, binding);
      if (revisionId) {
        if (revision?.revisionId !== revisionId) return yield* staleRevision();
        return yield* engineRevision(service, binding);
      }
      // The engine freezes only active workspaces; a frozen or prepared one keeps its revision.
      if (revision && (status === "frozen" || status === "prepared"))
        return yield* engineRevision(service, binding);
      return yield* service.freeze(target).pipe(Effect.mapError(mapWorkspaceError));
    });
  /** Freezes or reuses the current revision; a freeze after resume or revision settles its reopen. */
  const settledRevision = (
    service: WorkspaceServiceContract,
    { binding, heldLocked }: HeldBinding,
    revisionId: string | undefined,
  ): Effect.Effect<WorkspaceRevision, SubagentError> =>
    Effect.gen(function* () {
      const reopened = revisionKnowledge(binding)?.kind === "reopened" && !revisionId;
      const revision = yield* reviewedRevision(service, binding, revisionId);
      yield* withLock(
        heldLocked().pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (reopened) updateKnowledge(binding, () => ({ kind: "unreviewed" }));
            }),
          ),
        ),
      );
      return revision;
    });
  /**
   * Prepares the revision, or only `paths` of it. The preparation isn't integrable until the
   * caller records it, after `provisionHeld` runs its WorktreeCreate hooks when it is for testing.
   */
  const prepareHeld = (
    service: WorkspaceServiceContract,
    { binding }: HeldBinding,
    revisionId: string,
    paths?: ReadonlyArray<string>,
  ): Effect.Effect<WorkspacePreparation, SubagentError> =>
    Effect.gen(function* () {
      yield* withLock(Effect.sync(() => updateKnowledge(binding, withoutPreparation)));
      const preparation = yield* service
        .prepare({
          workspaceId: binding.handle.workspaceId,
          ownerId: binding.handle.ownerId,
          revisionId,
          paths,
        })
        .pipe(Effect.mapError(mapWorkspaceError));
      return preparation;
    });
  /** Runs the WorktreeCreate hooks in a held binding's prepared tree. */
  const provisionHeld = (
    service: WorkspaceServiceContract,
    { binding }: HeldBinding,
    preparation: WorkspacePreparation,
  ): Effect.Effect<void, SubagentError> =>
    runWorktreeCreateHooks(service, worktreeCreate, binding.handle, {
      preparationId: preparation.preparationId,
      runId: binding.record?.view.id,
    });
  /** Records a held binding's preparation under the run lock. */
  const markPrepared = (
    { binding, heldLocked }: HeldBinding,
    preparation: WorkspacePreparation,
    origin: "prepare" | "apply",
  ) =>
    heldLocked().pipe(
      Effect.andThen(
        Effect.sync(() => updateKnowledge(binding, withPreparation(preparation, origin))),
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
    outcome: "discarded" | "auto-discarded" = "discarded",
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
      // A stopped integration was rolled back, so the source leases it kept are released.
      const settled = settledState(binding);
      const leases = settled?.phase === "stopped-integration" ? settled.leases : [];
      settleBinding(binding, { phase: "finished", outcome });
      recordWorkspaceOutcomeLocked(binding, { status: outcome });
      yield* publish;
      for (const lease of leases.toReversed())
        yield* context.writerLeases.release(lease).pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `Rolled-back integration lease release is unconfirmed: ${error.message}`,
            ).pipe(
              Effect.annotateLogs("workspaceId", workspaceId),
              Effect.andThen(
                Effect.sync(() => {
                  state.integrationQuarantined = true;
                }),
              ),
            ),
          ),
        );
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
          const current = yield* settledRevision(service, held, options.revisionId);
          const text = revisionReviewText(current);
          const { diff: _diff, ...revision } = current;
          return yield* withLock(
            Effect.gen(function* () {
              yield* heldLocked();
              if (offset > text.length)
                return yield* invalid(
                  "workspace_diff_bounds",
                  "Review offset exceeds this revision.",
                );
              const nextOffset = pageEnd(text, offset, limit);
              updateKnowledge(binding, (knowledge) =>
                readThrough(knowledge, revision.revisionId, text.length, offset, nextOffset),
              );
              return {
                ...revision,
                text: text.slice(offset, nextOffset),
                offset,
                totalChars: text.length,
                ...(nextOffset < text.length && { nextOffset }),
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
  ): Effect.Effect<WorkspacePrepared, SubagentError> =>
    Effect.gen(function* () {
      const service = yield* requireEngine;
      return yield* operate(workspaceId, caller, (held) =>
        Effect.gen(function* () {
          const { binding } = held;
          const { revision } = yield* engineRecord(service, binding);
          const reviewed = yield* withLock(
            Effect.sync(() => fullyReviewed(revisionKnowledge(binding), revisionId)),
          );
          if (!reviewed || revision?.revisionId !== revisionId)
            return yield* invalid(
              "workspace_review_incomplete",
              "Read every page of this exact immutable revision before preparing integration.",
            );
          // The careful path leaves testing to the parent in the prepared tree.
          const preparation = yield* prepareHeld(service, held, revisionId);
          yield* provisionHeld(service, held, preparation);
          yield* withLock(markPrepared(held, preparation, "prepare"));
          return { ...preparation, leftOutPaths: revision.uncapturedPaths ?? [] };
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
    held: {
      hold,
      operate,
      settledRevision,
      prepareHeld,
      provisionHeld,
      markPrepared,
      discardLocked,
    },
  };
}
