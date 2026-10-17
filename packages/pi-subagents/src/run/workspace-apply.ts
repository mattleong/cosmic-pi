import * as Effect from "effect/Effect";
import type { WorkspaceVerify } from "../config/schema.ts";
import type { WorkspacePreparation } from "../workspace/model.ts";
import type { WorkspaceServiceContract } from "../workspace/service.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import { SUBAGENT_ROOT_RUN_ID } from "./model.ts";
import { type WorkspaceControlContext, workspaceFinishedError } from "./workspace-binding.ts";
import type {
  WorkspaceIntegrationOutcome,
  workspaceIntegrationOperations,
} from "./workspace-integration.ts";
import type { HeldBinding, workspaceReviewOperations } from "./workspace-review.ts";

export const MAX_APPLY_LISTED_PATHS = 20;

export interface WorkspaceApplyOptions {
  /** When given, the current frozen revision must be exactly this one. */
  readonly revisionId?: string | undefined;
}

export type WorkspaceApplyVerification =
  | { readonly status: "not-configured" }
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
  /** The first changed paths of the revision; `changedPathCount` counts them all. */
  readonly changedPaths: ReadonlyArray<string>;
  readonly changedPathCount: number;
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
  "Nothing was applied. Inspect the prepared tree, then revise or discard the workspace, or review every page, prepare again, and integrate that new preparation.";

export function workspaceApplyOperations(
  context: WorkspaceControlContext,
  phases: ReturnType<typeof workspaceReviewOperations>["held"],
  integrateLocked: ReturnType<typeof workspaceIntegrationOperations>["integrateLocked"],
) {
  const { withLock, operations, requireEngine, state, workspaceVerify } = context;
  // Like setup, an unconfirmed verify cleanup keeps the binding quarantined until the engine clears it.
  const verifyPrepared = (
    service: WorkspaceServiceContract,
    { binding }: HeldBinding,
    preparation: WorkspacePreparation,
    verify: WorkspaceVerify,
  ): Effect.Effect<WorkspaceApplyVerification, SubagentError> =>
    Effect.gen(function* () {
      yield* withLock(
        Effect.sync(() => {
          binding.setupCleanupPending = true;
        }),
      );
      return yield* service
        .verify({
          workspaceId: binding.handle.workspaceId,
          ownerId: binding.handle.ownerId,
          preparationId: preparation.preparationId,
          verify,
          onQuarantineCleared: () => {
            binding.setupCleanupPending = false;
          },
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
    });
  /**
   * Freezes, prepares, verifies, and integrates in one call from the direct parent, without
   * requiring the diff to be read. The binding stays busy throughout; the operations permit is
   * held per phase and released while verification runs. Only a committed integration publishes.
   */
  const workspaceApply = (
    workspaceId: string,
    options: WorkspaceApplyOptions = {},
    caller = SUBAGENT_ROOT_RUN_ID,
  ): Effect.Effect<WorkspaceApplyResult, SubagentError> =>
    Effect.gen(function* () {
      const service = yield* requireEngine;
      return yield* phases.hold(workspaceId, caller, (held) =>
        Effect.gen(function* () {
          const { binding, heldLocked, token } = held;
          const { revision, reviewed } = yield* operations.withPermits(1)(
            Effect.gen(function* () {
              yield* withLock(
                Effect.gen(function* () {
                  if (binding.finished) return yield* workspaceFinishedError(binding);
                  if (state.integrationQuarantined)
                    return yield* invalid(
                      "workspace_integration_quarantined",
                      "Integration ownership is quarantined; further integration is blocked pending manual recovery.",
                    );
                  return undefined;
                }),
              );
              const current = yield* phases.settledRevision(service, held, options.revisionId);
              return {
                revision: current,
                reviewed: yield* withLock(
                  Effect.sync(
                    () =>
                      binding.reviewedRevision === current.revisionId &&
                      binding.reviewedThrough === current.diff.length,
                  ),
                ),
              };
            }),
          );
          const preparation = yield* operations.withPermits(1)(
            phases.prepareHeld(service, held, revision.revisionId),
          );
          const common: WorkspaceApplyCommon = {
            revisionId: revision.revisionId,
            preparationId: preparation.preparationId,
            preparedCwd: preparation.cwd,
            changedPaths: revision.changedPaths.slice(0, MAX_APPLY_LISTED_PATHS),
            changedPathCount: revision.changedPaths.length,
            reviewed,
          };
          const verification: WorkspaceApplyVerification = workspaceVerify
            ? yield* verifyPrepared(service, held, preparation, workspaceVerify)
            : { status: "not-configured" };
          if (verification.status === "failed") {
            yield* withLock(
              heldLocked().pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    binding.verificationFailedPreparation = preparation.preparationId;
                  }),
                ),
              ),
            );
            return {
              ...common,
              integrated: false as const,
              verification,
              nextSteps: VERIFICATION_NEXT_STEPS,
            };
          }
          const integration = yield* operations.withPermits(1)(
            withLock(
              heldLocked().pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    binding.testedPreparation = preparation.preparationId;
                  }),
                ),
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
          return { ...common, ...integration, integrated: true as const, verification };
        }),
      );
    });
  return workspaceApply;
}
