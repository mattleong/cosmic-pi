import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import { revisionSummary } from "../workspace/diffstat.ts";
import type {
  WorkspacePreparation,
  WorkspaceRevision,
  WorkspaceRevisionMetadata,
  WorkspaceSettledTarget,
} from "../workspace/model.ts";
import type { WorkspaceServiceContract } from "../workspace/service.ts";
import { invalidRequest as invalid, type SubagentError, withGuidance } from "./errors.ts";
import { SUBAGENT_ROOT_RUN_ID } from "./model.ts";
import {
  type HeldBinding,
  holdBindingLocked,
  isTreeInUse,
  mapWorkspaceError,
  type RevisionKnowledge,
  revisionKnowledge,
  recordWorkspaceOutcomeLocked,
  releaseBindingLocked,
  settleBinding,
  updateKnowledge,
  type WorkspaceBinding,
  workspaceBusyError,
  type WorkspaceControlContext,
} from "./workspace-binding.ts";
import { runWorktreeCreateHooks } from "./workspace-hooks.ts";
import { integrationTarget } from "./workspace-integration.ts";

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
}

/** UTF-16 units per review page. */
const REVIEW_PAGE_CHARS = 16_000;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Where a page starting at `offset` ends: at most one page of UTF-16 units, never between the two
 * halves of a character.
 */
const pageEnd = (text: string, offset: number) => {
  const end = Math.min(text.length, offset + REVIEW_PAGE_CHARS);
  if (
    end >= text.length ||
    !Option.exists(Str.charCodeAt(text, end - 1), isHighSurrogate) ||
    !Option.exists(Str.charCodeAt(text, end), isLowSurrogate)
  )
    return end;
  return end - 1;
};

const engineRecord = (service: WorkspaceServiceContract, { handle }: WorkspaceBinding) =>
  service
    .inspect({ workspaceId: handle.workspaceId, ownerId: handle.ownerId })
    .pipe(Effect.mapError(mapWorkspaceError));

const staleRevision = () =>
  invalid("workspace_revision_stale", "The immutable workspace revision no longer matches.");

const engineRevision = (service: WorkspaceServiceContract, { handle }: WorkspaceBinding) =>
  service
    .revision({ workspaceId: handle.workspaceId, ownerId: handle.ownerId })
    .pipe(
      Effect.mapError(mapWorkspaceError),
      Effect.filterOrFail(Predicate.isNotUndefined, staleRevision),
    );

/** A review of the current revision; a preparation of it stays integrable. */
const reviewed = (knowledge: RevisionKnowledge, revisionId: string): RevisionKnowledge =>
  knowledge.kind === "prepared" && knowledge.revisionId === revisionId
    ? knowledge
    : { kind: "frozen" };

/** The engine replaces any earlier preparation, which is no longer integrable from here on. */
const withoutPreparation = (knowledge: RevisionKnowledge): RevisionKnowledge =>
  knowledge.kind === "prepared" ? { kind: "frozen" } : knowledge;

/** Records a ready preparation, which makes it integrable. */
const withPreparation =
  (preparation: WorkspacePreparation, origin: "prepare" | "apply") => (): RevisionKnowledge => ({
    kind: "prepared",
    revisionId: preparation.revisionId,
    preparationId: preparation.preparationId,
    origin,
  });

export function workspaceReviewOperations(
  context: WorkspaceControlContext,
  publish: Effect.Effect<void>,
) {
  const { records, withLock, state, requireBinding, requireEngine, operations } = context;
  const { worktreeCreate, excludeTrees } = context;
  const checkout = integrationTarget(context);
  /** Marks the binding busy for `use`, so resume, revise, and other operations refuse it. */
  const hold = <A>(
    workspaceId: string,
    caller: string,
    use: (held: HeldBinding) => Effect.Effect<A, SubagentError>,
  ): Effect.Effect<A, SubagentError> =>
    Effect.acquireUseRelease(
      withLock(
        requireBinding(workspaceId, caller).pipe(
          Effect.flatMap((binding) =>
            Effect.suspend(() => {
              const held = holdBindingLocked(state.bindings, binding);
              return held ? Effect.succeed(held) : Effect.fail(workspaceBusyError());
            }),
          ),
        ),
      ),
      use,
      (held) => withLock(Effect.sync(() => releaseBindingLocked(held))),
    );
  const operate = <A>(
    workspaceId: string,
    caller: string,
    use: (held: HeldBinding) => Effect.Effect<A, SubagentError>,
  ): Effect.Effect<A, SubagentError> => operations.withPermits(1)(hold(workspaceId, caller, use));
  const reviewedRevision = Effect.fn("SubagentWorkspace.reviewedRevision")(function* (
    service: WorkspaceServiceContract,
    binding: WorkspaceBinding,
    revisionId: string | undefined,
  ): Effect.fn.Return<WorkspaceRevision, SubagentError> {
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
  const settledRevision = Effect.fn("SubagentWorkspace.settledRevision")(function* (
    service: WorkspaceServiceContract,
    { binding, heldLocked }: HeldBinding,
    revisionId: string | undefined,
  ): Effect.fn.Return<WorkspaceRevision, SubagentError> {
    const reopened = revisionKnowledge(binding)?.kind === "reopened" && !revisionId;
    const revision = yield* reviewedRevision(service, binding, revisionId);
    yield* withLock(
      heldLocked.pipe(
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
   * Prepares the revision. The preparation isn't integrable until the caller records it, after
   * `provisionHeld` runs its WorktreeCreate hooks when it is for testing.
   */
  const prepareHeld = Effect.fn("SubagentWorkspace.prepareHeld")(function* (
    service: WorkspaceServiceContract,
    { binding }: HeldBinding,
    revisionId: string,
  ): Effect.fn.Return<WorkspacePreparation, SubagentError> {
    yield* withLock(Effect.sync(() => updateKnowledge(binding, withoutPreparation)));
    return yield* service
      .prepare({
        workspaceId: binding.handle.workspaceId,
        ownerId: binding.handle.ownerId,
        revisionId,
      })
      .pipe(Effect.mapError(mapWorkspaceError));
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
    heldLocked.pipe(
      Effect.andThen(
        Effect.sync(() => updateKnowledge(binding, withPreparation(preparation, origin))),
      ),
    );
  /**
   * Like integration, destructive cleanup keeps admission out of the workspace's trees from the
   * cwd check through removal; the engine removes them outside the run lock. A stopped
   * integration's rollback writes the parent's files, so it also holds the integration target.
   * Natural writer completion does not stop its read-only descendants.
   */
  const discardHeld = Effect.fn("SubagentWorkspace.discardHeld")(function* (
    service: WorkspaceServiceContract,
    { binding, heldLocked }: HeldBinding,
    outcome: "discarded" | "auto-discarded" = "discarded",
  ): Effect.fn.Return<void, SubagentError> {
    const { workspaceId, ownerId } = binding.handle;
    const artifact = yield* service
      .inspect({ workspaceId, ownerId })
      .pipe(Effect.mapError(mapWorkspaceError));
    const { artifactRoot, sourceRoot } = artifact.handle;
    const integrating = artifact.status === "integrating";
    const discard = service
      .discard({ workspaceId, ownerId, processCleanupConfirmed: true })
      .pipe(Effect.mapError(mapWorkspaceError));
    yield* excludeTrees(
      Effect.gen(function* () {
        yield* heldLocked;
        if (isTreeInUse(records, state.launchReservations, artifactRoot))
          return yield* invalid(
            "workspace_process_unsettled",
            withGuidance(
              "A run still uses this workspace.",
              "Stop it and confirm cleanup before discard.",
            ),
          );
        if (integrating) yield* checkout.requireIdleLocked(sourceRoot);
        return { exclusion: { artifactRoot, target: integrating ? sourceRoot : undefined } };
      }),
      // Once the engine has discarded, the outcome commits even if the caller is cancelled.
      () =>
        Effect.uninterruptibleMask((restore) =>
          restore(
            integrating ? checkout.holdTarget(workspaceId, artifact.handle, discard) : discard,
          ).pipe(
            Effect.andThen(
              withLock(
                Effect.suspend(() => {
                  settleBinding(binding, { phase: "finished", outcome });
                  recordWorkspaceOutcomeLocked(binding, { status: outcome });
                  return publish;
                }),
              ),
            ),
          ),
        ),
    );
  });
  const workspaceReview = Effect.fn("SubagentWorkspace.workspaceReview")(function* (
    workspaceId: string,
    options: WorkspaceReviewOptions = {},
    caller: string = SUBAGENT_ROOT_RUN_ID,
  ): Effect.fn.Return<WorkspaceReview, SubagentError> {
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0)
      return yield* invalid(
        "workspace_diff_bounds",
        "Review offset must be a nonnegative integer.",
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
            yield* heldLocked;
            if (offset > text.length)
              return yield* invalid(
                "workspace_diff_bounds",
                "Review offset exceeds this revision.",
              );
            const nextOffset = pageEnd(text, offset);
            updateKnowledge(binding, (knowledge) => reviewed(knowledge, revision.revisionId));
            return {
              ...revision,
              text: Fn.pipe(text, Str.slice(offset, nextOffset)),
              offset,
              totalChars: text.length,
              ...(nextOffset < text.length && { nextOffset }),
            };
          }),
        );
      }),
    );
  });
  const workspacePrepare = Effect.fn("SubagentWorkspace.workspacePrepare")(function* (
    workspaceId: string,
    revisionId: string,
    caller: string = SUBAGENT_ROOT_RUN_ID,
  ): Effect.fn.Return<WorkspacePrepared, SubagentError> {
    const service = yield* requireEngine;
    return yield* operate(workspaceId, caller, (held) =>
      Effect.gen(function* () {
        const { binding } = held;
        const { revision } = yield* engineRecord(service, binding);
        const reopened = yield* withLock(
          Effect.sync(() => revisionKnowledge(binding)?.kind === "reopened"),
        );
        if (reopened || revision?.revisionId !== revisionId) return yield* staleRevision();
        // The careful path leaves testing to the parent in the prepared tree.
        const preparation = yield* prepareHeld(service, held, revisionId);
        yield* provisionHeld(service, held, preparation);
        yield* withLock(markPrepared(held, preparation, "prepare"));
        return { ...preparation, leftOutPaths: revision.uncapturedPaths ?? [] };
      }),
    );
  });
  const workspaceDiscard = Effect.fn("SubagentWorkspace.workspaceDiscard")(function* (
    workspaceId: string,
    caller: string = SUBAGENT_ROOT_RUN_ID,
  ): Effect.fn.Return<void, SubagentError> {
    const service = yield* requireEngine;
    yield* operate(workspaceId, caller, (held) => discardHeld(service, held));
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
      discardHeld,
    },
  };
}
