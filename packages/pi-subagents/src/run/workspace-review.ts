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
  type RevisionKnowledge,
  revisionKnowledge,
  runHoldsCwd,
  runsWithin,
  recordWorkspaceOutcomeLocked,
  settleBinding,
  settledState,
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

/** A binding this operation keeps busy; `heldLocked` confirms, under the run lock, it still does. */
interface HeldBinding {
  readonly binding: WorkspaceBinding;
  readonly token: symbol;
  readonly heldLocked: () => Effect.Effect<void, SubagentError>;
}

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
    !isHighSurrogate(text.charCodeAt(end - 1)) ||
    !isLowSurrogate(text.charCodeAt(end))
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
  service.revision({ workspaceId: handle.workspaceId, ownerId: handle.ownerId }).pipe(
    Effect.mapError(mapWorkspaceError),
    Effect.filterOrFail(
      (revision): revision is WorkspaceRevision => revision !== undefined,
      staleRevision,
    ),
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
  const { records, withLock, state, requireBinding, requireEngine, operations, worktreeCreate } =
    context;
  const checkout = integrationTarget(context);
  /** Marks the binding busy for `use`, so resume, revise, and other operations refuse it. */
  const hold = <A>(
    workspaceId: string,
    caller: string,
    use: (held: HeldBinding) => Effect.Effect<A, SubagentError>,
  ): Effect.Effect<A, SubagentError> =>
    Effect.acquireUseRelease(
      withLock(
        Effect.gen(function* () {
          const binding = yield* requireBinding(workspaceId, caller);
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
   * Prepares the revision. The preparation isn't integrable until the caller records it, after
   * `provisionHeld` runs its WorktreeCreate hooks when it is for testing.
   */
  const prepareHeld = (
    service: WorkspaceServiceContract,
    { binding }: HeldBinding,
    revisionId: string,
  ): Effect.Effect<WorkspacePreparation, SubagentError> =>
    Effect.gen(function* () {
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
    heldLocked().pipe(
      Effect.andThen(
        Effect.sync(() => updateKnowledge(binding, withPreparation(preparation, origin))),
      ),
    );
  /**
   * Like integration, destructive cleanup holds admission closed from the cwd check through
   * removal, so callers run this under the run lock. A stopped integration's rollback writes the
   * parent's files, so it also holds the integration target. Natural writer completion does not
   * stop its read-only descendants.
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
      if ([...runsWithin(records, [artifact.handle.artifactRoot]).keys()].some(runHoldsCwd))
        return yield* invalid(
          "workspace_process_unsettled",
          "A run still uses this workspace. Stop it and confirm cleanup before discard.",
        );
      const discard = service
        .discard({ workspaceId, ownerId, processCleanupConfirmed: true })
        .pipe(Effect.mapError(mapWorkspaceError));
      if (artifact.status === "integrating") {
        yield* checkout.requireIdleLocked(artifact.handle.sourceRoot);
        yield* checkout.holdLocked(workspaceId, artifact.handle, discard);
      } else yield* discard;
      settleBinding(binding, { phase: "finished", outcome });
      recordWorkspaceOutcomeLocked(binding, { status: outcome });
      yield* publish;
      return undefined;
    });
  const workspaceReview = (
    workspaceId: string,
    options: WorkspaceReviewOptions = {},
    caller = SUBAGENT_ROOT_RUN_ID,
  ): Effect.Effect<WorkspaceReview, SubagentError> =>
    Effect.gen(function* () {
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
              yield* heldLocked();
              if (offset > text.length)
                return yield* invalid(
                  "workspace_diff_bounds",
                  "Review offset exceeds this revision.",
                );
              const nextOffset = pageEnd(text, offset);
              updateKnowledge(binding, (knowledge) => reviewed(knowledge, revision.revisionId));
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
  const workspaceDiscard = (
    workspaceId: string,
    caller = SUBAGENT_ROOT_RUN_ID,
  ): Effect.Effect<void, SubagentError> =>
    Effect.gen(function* () {
      const service = yield* requireEngine;
      yield* operate(workspaceId, caller, ({ binding, heldLocked }) =>
        withLock(heldLocked().pipe(Effect.andThen(discardLocked(service, binding)))),
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
