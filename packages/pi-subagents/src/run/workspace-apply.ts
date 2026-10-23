import * as Effect from "effect/Effect";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import { SUBAGENT_ROOT_RUN_ID } from "./model.ts";
import {
  isBindingFinished,
  revisionKnowledge,
  type WorkspaceControlContext,
  workspaceFinishedError,
} from "./workspace-binding.ts";
import type {
  WorkspaceIntegrationOutcome,
  WorkspaceIntegrationResult,
  workspaceIntegrationOperations,
} from "./workspace-integration.ts";
import type { workspaceReviewOperations } from "./workspace-review.ts";

const MAX_APPLY_LISTED_PATHS = 20;

/**
 * Apply integrates the parent's preparation of the current revision, or else freezes, prepares,
 * and integrates it; `revisionId` optionally pins that revision.
 */
export interface WorkspaceApplyOptions {
  readonly revisionId?: string | undefined;
}

/**
 * `parent-tested`: apply integrated the parent's own prepared pair, which the parent was to test.
 * `untested`: apply prepared and integrated in one call, testing nothing.
 */
type WorkspaceApplyTesting = "parent-tested" | "untested";

export interface WorkspaceApplyResult extends WorkspaceIntegrationOutcome {
  readonly revisionId: string;
  readonly preparationId: string;
  /** The prepared tree the integration published from. */
  readonly preparedCwd: string;
  /** The first changed paths applied; `changedPathCount` counts them all. */
  readonly changedPaths: ReadonlyArray<string>;
  readonly changedPathCount: number;
  /** Credential files the worker created, which the revision leaves out on purpose. */
  readonly leftOutPaths: ReadonlyArray<string>;
  readonly testing: WorkspaceApplyTesting;
}

const appliedResult = (
  { changedPaths, ...integration }: WorkspaceIntegrationResult,
  revisionId: string,
  preparationId: string,
  testing: WorkspaceApplyTesting,
): WorkspaceApplyResult => ({
  ...integration,
  revisionId,
  preparationId,
  changedPaths: changedPaths.slice(0, MAX_APPLY_LISTED_PATHS),
  changedPathCount: changedPaths.length,
  testing,
});

export function workspaceApplyOperations(
  context: WorkspaceControlContext,
  phases: ReturnType<typeof workspaceReviewOperations>["held"],
  integrateLocked: ReturnType<typeof workspaceIntegrationOperations>,
) {
  const { withLock, operations, requireEngine, state } = context;
  /**
   * Integrates the preparation the parent's `prepare` made of the current revision when it
   * matches any pinned revision; otherwise freezes, prepares, and integrates in one call. That
   * one-call preparation runs no WorktreeCreate hooks: nothing is tested in it. The binding stays
   * busy throughout; the operations permit is held per phase. Only a committed integration
   * publishes.
   */
  const workspaceApply = Effect.fn("SubagentWorkspace.workspaceApply")(function* (
    workspaceId: string,
    { revisionId: pinnedRevisionId }: WorkspaceApplyOptions = {},
    caller: string = SUBAGENT_ROOT_RUN_ID,
  ): Effect.fn.Return<WorkspaceApplyResult, SubagentError> {
    const service = yield* requireEngine;
    return yield* phases.hold(workspaceId, caller, (held) =>
      Effect.gen(function* () {
        const { binding, token } = held;
        const integrate = (revisionId: string, preparationId: string) =>
          integrateLocked(workspaceId, revisionId, preparationId, caller, token);
        const prepared = yield* withLock(
          Effect.gen(function* () {
            if (isBindingFinished(binding)) return yield* workspaceFinishedError(binding);
            if (state.integrationQuarantined)
              return yield* invalid(
                "workspace_integration_quarantined",
                "Integration ownership is quarantined; further integration is blocked pending manual recovery.",
              );
            const knowledge = revisionKnowledge(binding);
            return knowledge?.kind === "prepared" &&
              knowledge.origin === "prepare" &&
              (pinnedRevisionId === undefined || pinnedRevisionId === knowledge.revisionId)
              ? knowledge
              : undefined;
          }),
        );
        if (prepared) {
          const integration = yield* operations.withPermits(1)(
            withLock(integrate(prepared.revisionId, prepared.preparationId)),
          );
          return appliedResult(
            integration,
            prepared.revisionId,
            prepared.preparationId,
            "parent-tested",
          );
        }
        const revision = yield* operations.withPermits(1)(
          phases.settledRevision(service, held, pinnedRevisionId),
        );
        const preparation = yield* operations.withPermits(1)(
          phases.prepareHeld(service, held, revision.revisionId),
        );
        const integration = yield* operations.withPermits(1)(
          withLock(
            phases
              .markPrepared(held, preparation, "apply")
              .pipe(Effect.andThen(integrate(revision.revisionId, preparation.preparationId))),
          ),
        );
        return appliedResult(
          integration,
          revision.revisionId,
          preparation.preparationId,
          "untested",
        );
      }),
    );
  });
  return workspaceApply;
}
