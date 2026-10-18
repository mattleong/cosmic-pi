import * as Effect from "effect/Effect";
import type { WorkspaceRevisionMetadata } from "../workspace/model.ts";
import { partialSelection } from "../workspace/policy.ts";
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
 * Without `preparationId`, apply integrates the parent's matching preparation, or else freezes,
 * prepares, and integrates; `revisionId` then optionally pins the current revision, and `paths`
 * limits it to those changed paths. With it, apply integrates exactly that prepared pair.
 */
export type WorkspaceApplyOptions =
  | {
      readonly revisionId?: string | undefined;
      readonly preparationId?: undefined;
      readonly paths?: ReadonlyArray<string> | undefined;
    }
  | { readonly revisionId: string; readonly preparationId: string; readonly paths?: undefined };

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
  /**
   * The first paths applied: the revision's changed paths, or a partial apply's subset;
   * `changedPathCount` counts them all.
   */
  readonly changedPaths: ReadonlyArray<string>;
  readonly changedPathCount: number;
  /**
   * A partial apply's first changed paths left out, which stay in the workspace as its proposal;
   * `remainingPathCount` counts them all.
   */
  readonly remainingPaths?: ReadonlyArray<string> | undefined;
  readonly remainingPathCount?: number | undefined;
  /** Credential files the worker created, which the revision leaves out on purpose. */
  readonly leftOutPaths: ReadonlyArray<string>;
  /** Whether the parent had read every page of this revision; apply never requires it. */
  readonly reviewed: boolean;
  readonly testing: WorkspaceApplyTesting;
}

const appliedResult = (
  { changedPaths, remainingPaths, ...integration }: WorkspaceIntegrationResult,
  revisionId: string,
  preparationId: string,
  testing: WorkspaceApplyTesting,
): WorkspaceApplyResult => ({
  ...integration,
  revisionId,
  preparationId,
  changedPaths: changedPaths.slice(0, MAX_APPLY_LISTED_PATHS),
  changedPathCount: changedPaths.length,
  ...(remainingPaths !== undefined && {
    remainingPaths: remainingPaths.slice(0, MAX_APPLY_LISTED_PATHS),
    remainingPathCount: remainingPaths.length,
  }),
  testing,
});

/** The subset of a revision's changed paths a partial apply names; undefined for all of them. */
const selectedPaths = (
  revision: WorkspaceRevisionMetadata,
  paths: ReadonlyArray<string> | undefined,
): Effect.Effect<ReadonlyArray<string> | undefined, SubagentError> =>
  Effect.gen(function* () {
    if (paths === undefined) return undefined;
    if (paths.length === 0)
      return yield* invalid("workspace_paths_unknown", "A partial apply needs at least one path.");
    const { unknown, subset } = partialSelection(revision.changedPaths, paths);
    if (unknown.length > 0)
      return yield* invalid(
        "workspace_paths_unknown",
        `Revision ${revision.revisionId} doesn't change ${unknown
          .slice(0, MAX_APPLY_LISTED_PATHS)
          .map((name) => JSON.stringify(name))
          .join(
            ", ",
          )}${unknown.length > MAX_APPLY_LISTED_PATHS ? ` and ${unknown.length - MAX_APPLY_LISTED_PATHS} more` : ""}. Name exact changed paths from its review summary.`,
      );
    return subset;
  });

export function workspaceApplyOperations(
  context: WorkspaceControlContext,
  phases: ReturnType<typeof workspaceReviewOperations>["held"],
  integrateLocked: ReturnType<typeof workspaceIntegrationOperations>,
) {
  const { withLock, operations, requireEngine, state } = context;
  /**
   * Integrates the parent's own prepared pair when it matches the request; otherwise freezes,
   * prepares, and integrates in one call, without requiring the diff to be read. That one-call
   * preparation runs no WorktreeCreate hooks: nothing is tested in it. The binding stays busy
   * throughout; the operations permit is held per phase. Only a committed integration publishes.
   */
  const applyCurrent = (
    workspaceId: string,
    pinnedRevisionId: string | undefined,
    requestedPaths: ReadonlyArray<string> | undefined,
    caller: string,
  ): Effect.Effect<WorkspaceApplyResult, SubagentError> =>
    Effect.gen(function* () {
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
                requestedPaths === undefined &&
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
          const paths = yield* selectedPaths(revision, requestedPaths);
          const preparation = yield* operations.withPermits(1)(
            phases.prepareHeld(service, held, revision.revisionId, paths),
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
  const workspaceApply = (
    workspaceId: string,
    options: WorkspaceApplyOptions = {},
    caller = SUBAGENT_ROOT_RUN_ID,
  ): Effect.Effect<WorkspaceApplyResult, SubagentError> =>
    options.preparationId === undefined
      ? applyCurrent(workspaceId, options.revisionId, options.paths, caller)
      : // The parent reviewed, prepared, and tested this pair; integration rechecks it all.
        operations
          .withPermits(1)(
            withLock(
              integrateLocked(workspaceId, options.revisionId, options.preparationId, caller),
            ),
          )
          .pipe(
            Effect.map((integration) =>
              appliedResult(
                integration,
                options.revisionId,
                options.preparationId,
                "parent-tested",
              ),
            ),
          );
  return workspaceApply;
}
