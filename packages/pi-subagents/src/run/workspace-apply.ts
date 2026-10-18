import * as Effect from "effect/Effect";
import type { WorkspaceVerify } from "../config/schema.ts";
import type { WorkspacePreparation, WorkspaceRevisionMetadata } from "../workspace/model.ts";
import { leftOutUncapturedPaths, partialSelection } from "../workspace/policy.ts";
import type { WorkspaceServiceContract } from "../workspace/service.ts";
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
import {
  fullyReviewed,
  type HeldBinding,
  type workspaceReviewOperations,
} from "./workspace-review.ts";

export const MAX_APPLY_LISTED_PATHS = 20;

/**
 * Without `preparationId`, apply freezes, prepares, verifies, and integrates; `revisionId` then
 * optionally pins the current frozen revision, and `paths` limits it to those changed paths. With
 * it, apply integrates exactly that reviewed and prepared pair.
 */
export type WorkspaceApplyOptions =
  | {
      readonly revisionId?: string | undefined;
      readonly preparationId?: undefined;
      readonly paths?: ReadonlyArray<string> | undefined;
    }
  | { readonly revisionId: string; readonly preparationId: string; readonly paths?: undefined };

export type WorkspaceApplyVerification =
  | { readonly status: "not-configured" }
  /** Apply integrated the parent's own prepared pair, which the parent was to test. */
  | { readonly status: "parent-tested" }
  | {
      readonly status: "passed";
      readonly command: ReadonlyArray<string>;
      readonly outputTail: string;
    }
  | {
      readonly status: "failed";
      readonly command: ReadonlyArray<string>;
      readonly outputTail: string;
      readonly message: string;
    };

interface WorkspaceApplyCommon {
  readonly revisionId: string;
  readonly preparationId: string;
  /** The prepared tree that setup and verification ran in. */
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
  /** Worker files left out on purpose because they sit in dependency, build, or Pi state directories. */
  readonly leftOutPaths: ReadonlyArray<string>;
  /** Whether the parent had read every page of this revision; apply never requires it. */
  readonly reviewed: boolean;
}

export type WorkspaceApplyResult =
  | (WorkspaceApplyCommon &
      WorkspaceIntegrationOutcome & {
        readonly integrated: true;
        readonly verification: Exclude<WorkspaceApplyVerification, { readonly status: "failed" }>;
      })
  | (WorkspaceApplyCommon & {
      readonly integrated: false;
      readonly verification: Extract<WorkspaceApplyVerification, { readonly status: "failed" }>;
      readonly nextSteps: string;
    });

const VERIFICATION_NEXT_STEPS =
  "Nothing was applied. Inspect the prepared tree, then revise or discard the workspace, or review every page, prepare again, and apply that new preparation.";

const listedPaths = (
  changedPaths: ReadonlyArray<string>,
  remainingPaths: ReadonlyArray<string> | undefined,
) => ({
  changedPaths: changedPaths.slice(0, MAX_APPLY_LISTED_PATHS),
  changedPathCount: changedPaths.length,
  ...(remainingPaths !== undefined && {
    remainingPaths: remainingPaths.slice(0, MAX_APPLY_LISTED_PATHS),
    remainingPathCount: remainingPaths.length,
  }),
});

const integratedResult = (
  { changedPaths, remainingPaths, ...integration }: WorkspaceIntegrationResult,
  revisionId: string,
  preparationId: string,
  verification: Exclude<WorkspaceApplyVerification, { readonly status: "failed" }>,
): WorkspaceApplyResult => ({
  ...integration,
  revisionId,
  preparationId,
  ...listedPaths(changedPaths, remainingPaths),
  integrated: true,
  verification,
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
  const { withLock, operations, requireEngine, state, workspaceVerify } = context;
  // Like setup, an unconfirmed verify cleanup leaves the engine's marker, which quarantines the binding.
  const verifyPrepared = (
    service: WorkspaceServiceContract,
    { binding }: HeldBinding,
    preparation: WorkspacePreparation,
    verify: WorkspaceVerify,
  ): Effect.Effect<WorkspaceApplyVerification, SubagentError> =>
    service
      .verify({
        workspaceId: binding.handle.workspaceId,
        ownerId: binding.handle.ownerId,
        preparationId: preparation.preparationId,
        verify,
      })
      .pipe(
        Effect.map(
          ({ outputTail }): WorkspaceApplyVerification => ({
            status: "passed",
            command: verify.command,
            outputTail,
          }),
        ),
        Effect.catch((error) =>
          error.cleanupUnconfirmed
            ? Effect.fail(
                invalid(
                  "workspace_verify_cleanup_unconfirmed",
                  `${error.message} Independently confirm the verification process and all descendants have stopped, then recover the private trees manually.`,
                ),
              )
            : Effect.succeed<WorkspaceApplyVerification>({
                status: "failed",
                command: verify.command,
                outputTail: error.detail ?? "",
                message: error.message,
              }),
        ),
      );
  /**
   * Freezes, prepares, verifies, and integrates in one call from the direct parent, without
   * requiring the diff to be read. The binding stays busy throughout; the operations permit is
   * held per phase and released while verification runs. Only a committed integration publishes.
   * Setup runs in the prepared tree only for verification, which is all that tests it there.
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
          const { revision, reviewed } = yield* operations.withPermits(1)(
            Effect.gen(function* () {
              yield* withLock(
                Effect.gen(function* () {
                  if (isBindingFinished(binding)) return yield* workspaceFinishedError(binding);
                  if (state.integrationQuarantined)
                    return yield* invalid(
                      "workspace_integration_quarantined",
                      "Integration ownership is quarantined; further integration is blocked pending manual recovery.",
                    );
                  return undefined;
                }),
              );
              const current = yield* phases.settledRevision(service, held, pinnedRevisionId);
              return {
                revision: current,
                reviewed: yield* withLock(
                  Effect.sync(() => fullyReviewed(revisionKnowledge(binding), current.revisionId)),
                ),
              };
            }),
          );
          const paths = yield* selectedPaths(revision, requestedPaths);
          const preparation = yield* operations.withPermits(1)(
            phases.prepareHeld(
              service,
              held,
              revision.revisionId,
              workspaceVerify !== undefined,
              paths,
            ),
          );
          const verification: WorkspaceApplyVerification = workspaceVerify
            ? yield* verifyPrepared(service, held, preparation, workspaceVerify)
            : { status: "not-configured" };
          if (verification.status === "failed") {
            yield* withLock(phases.markPrepared(held, preparation, "failed"));
            return {
              revisionId: revision.revisionId,
              preparationId: preparation.preparationId,
              preparedCwd: preparation.cwd,
              ...listedPaths(
                paths ?? revision.changedPaths,
                paths && revision.changedPaths.filter((name) => !paths.includes(name)),
              ),
              leftOutPaths: leftOutUncapturedPaths(revision.uncapturedPaths),
              reviewed,
              integrated: false as const,
              verification,
              nextSteps: VERIFICATION_NEXT_STEPS,
            };
          }
          const integration = yield* operations.withPermits(1)(
            withLock(
              phases
                .markPrepared(held, preparation, "tested")
                .pipe(
                  Effect.andThen(
                    integrateLocked(
                      workspaceId,
                      revision.revisionId,
                      preparation.preparationId,
                      caller,
                      token,
                    ),
                  ),
                ),
            ),
          );
          return integratedResult(
            integration,
            revision.revisionId,
            preparation.preparationId,
            verification,
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
              integratedResult(integration, options.revisionId, options.preparationId, {
                status: "parent-tested",
              }),
            ),
          );
  return workspaceApply;
}
