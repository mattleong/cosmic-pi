/** Checkpoint request and catch-up wait controls. */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { advisorNow } from "../../boundary/clock.ts";
import type { AdvisorEffectExecutor, AdvisorPlatform } from "../../boundary/executor.ts";
import type { CheckpointOrchestratorContract } from "../../checkpoint/orchestrator.ts";
import {
  captureAdvisorAbortInputAtHostBoundary,
  registerAdvisorAbortListenerAtHostBoundary,
  type AdvisorHostContextError,
} from "../../boundary/host-context.ts";
import { ADVISOR_OPERATION_TIMEOUT_MS, type ResolvedAdvisorConfig } from "../../config/options.ts";
import type { FailureLoggerContract } from "../../logging/logger.ts";
import type { AdvisorReviewQueue } from "../../queue/service.ts";
import { summarizeAdvisorReview } from "../../checkpoint/ledger.ts";
import type { AdvisorReviewFocus } from "../../review/index.ts";
import {
  awaitAdvisorCatchUpEffect,
  extensionError,
  type AdvisorCheckpointHandle,
  type CheckpointSettlement,
  type ParentAnchor,
  type ReviewPhase,
  type ReviewSource,
} from "../controller-types.ts";
import {
  applyBlockerVerification,
  incrementBounded,
  isVerificationCandidate,
  classifyFailure,
  verificationFingerprints,
} from "../controller-helpers.ts";
import type { AdvisorApplicationState } from "../state.ts";
import type { DeliverFn } from "./delivery.ts";
import { parentHasPendingMessages, parentSignalAborted } from "./parent-session.ts";

export interface CheckpointRefs {
  queue: AdvisorReviewQueue | undefined;
  runtimeCursor: { anchor: ParentAnchor; fingerprint: string } | undefined;
  checkpointId: number;
  configRevision: number;
  latestStateSummary: string;
  latestDurableSummary: ReturnType<typeof summarizeAdvisorReview>;
}

export interface CheckpointDeps {
  readonly refs: CheckpointRefs;
  readonly getState: () => AdvisorApplicationState;
  readonly updateApplicationState: (
    update: (state: AdvisorApplicationState) => AdvisorApplicationState,
  ) => void;
  readonly mutateMetrics: (mutate: (next: AdvisorApplicationState["metrics"]) => void) => void;
  readonly currentConfig: () => ResolvedAdvisorConfig;
  readonly isStarted: () => boolean;
  readonly advanceDomainCounter: (
    key: "epoch" | "cancellationEpoch" | "parentTurnId" | "requestSequence",
  ) => number;
  readonly latchCancellation: () => void;
  readonly clearPendingRecovery: () => void;
  readonly clearPendingReceipt: () => void;
  readonly persistCurrentLedger: (ctx: ExtensionContext) => void;
  readonly persistLedger: (anchor: ParentAnchor) => void;
  readonly notifyBestEffort: CheckpointNotify;
  readonly setAdvisorStatus: (ctx: ExtensionContext, text?: string) => void;
  readonly failureLogger: FailureLoggerContract;
  readonly applicationScope: Scope.Scope;
  readonly checkpointOrchestrator: CheckpointOrchestratorContract;
  readonly parentExecutor: AdvisorEffectExecutor;
  readonly runSessionEffect: <A, E>(
    effect: Effect.Effect<
      A,
      E,
      AdvisorPlatform | import("../../boundary/host-commands.ts").PiCommandAdapter
    >,
  ) => Promise<A>;
  readonly startRuntimeEffect: (
    ctx: ExtensionContext,
    restoration?: "preserve-live" | "restore-branch",
    allowDisabled?: boolean,
  ) => Effect.Effect<number | undefined, never, AdvisorPlatform>;
  readonly stopRuntime: () => Promise<void>;
  readonly deliver: DeliverFn;
  readonly fingerprint: () => string;
  readonly parentAnchor: (ctx: ExtensionContext) => ParentAnchor;
  readonly lifecycleScope: (ctx: ExtensionContext) => string;
  readonly branchContains: (ctx: ExtensionContext, anchor: ParentAnchor) => boolean;
  readonly recordReviewDuration: (
    target: AdvisorApplicationState["metrics"],
    startedAt: number,
  ) => AdvisorApplicationState["metrics"];
  readonly catchUpTimeoutMs: number;
}

type CheckpointNotify = (
  ctx: Pick<ExtensionContext, "ui">,
  message: string,
  level: "info" | "warning" | "error",
) => void;

export const makeCheckpointControls = (d: CheckpointDeps) => {
  const requestCheckpoint = (options: {
    ctx: ExtensionContext;
    focus: AdvisorReviewFocus;
    phase: ReviewPhase;
    source: ReviewSource;
    requiresEnabled: boolean;
    trajectoryId?: number;
    abortOnBlocker?: boolean;
  }): AdvisorCheckpointHandle | undefined => {
    const abortCapture = captureAdvisorAbortInputAtHostBoundary(options.ctx);
    if (!abortCapture.ok) return undefined;
    const requestAbortInput = abortCapture.input;
    if (
      (!d.refs.queue || !d.isStarted()) &&
      (!d.currentConfig().enabled || !d.currentConfig().configured)
    ) {
      return undefined;
    }
    let validForDelivery = true;
    let requestEpoch = d.getState().epoch;
    let requestCancellationEpoch = d.getState().cancellationEpoch;
    let activeQueue: AdvisorReviewQueue | undefined;
    let activeCheckpointId: string | undefined;
    const ledgerScope = d.lifecycleScope(options.ctx);
    const startedAt = advisorNow(d.parentExecutor);
    let durationRecorded = false;
    let outcomeRecorded = false;
    const finishReviewDuration = () => {
      if (durationRecorded) return;
      durationRecorded = true;
      d.updateApplicationState((state) => ({
        ...state,
        metrics: d.recordReviewDuration(state.metrics, startedAt),
      }));
    };
    const discardRequest = (): CheckpointSettlement => {
      if (!outcomeRecorded) {
        outcomeRecorded = true;
        d.mutateMetrics((next) => {
          next.discarded += 1;
          next.outcomes.discarded += 1;
        });
      }
      return "discarded";
    };
    const checkpointSettlement = Effect.gen(function* () {
      const cursorMismatch =
        !d.refs.runtimeCursor ||
        d.refs.runtimeCursor.fingerprint !== d.fingerprint() ||
        !d.branchContains(options.ctx, d.refs.runtimeCursor.anchor);
      if (cursorMismatch) {
        // One bounded restart remains part of this same checkpoint settlement,
        // so turn_end's hard catch-up barrier covers both re-seed and review.
        const restartEpoch = yield* d.startRuntimeEffect(
          options.ctx,
          "restore-branch",
          !options.requiresEnabled,
        );
        if (restartEpoch === undefined || restartEpoch !== d.getState().epoch) return "discarded";
      }
      if (!validForDelivery || !d.refs.queue || !d.isStarted() || !d.refs.runtimeCursor)
        return "discarded";
      if (
        options.trajectoryId !== undefined &&
        d.getState().activeTrajectory?.id !== options.trajectoryId
      )
        return "discarded";

      activeQueue = d.refs.queue;
      requestEpoch = d.getState().epoch;
      requestCancellationEpoch = d.getState().cancellationEpoch;
      const requestParentTurnId = d.getState().parentTurnId;
      const requestConfigRevision = d.refs.configRevision;
      const anchor = d.parentAnchor(options.ctx);
      const id = `advisor-${requestEpoch}-${++d.refs.checkpointId}`;
      activeCheckpointId = id;
      d.mutateMetrics((next) => {
        next.attempted += 1;
      });
      let checkpoint = yield* activeQueue
        .checkpointEffect({
          checkpointId: id,
          focus: options.focus,
          parentTurnId: requestParentTurnId,
        })
        .pipe(Effect.mapError(extensionError("checkpoint")));
      const requestIsCurrent = () =>
        validForDelivery &&
        requestEpoch === d.getState().epoch &&
        requestCancellationEpoch === d.getState().cancellationEpoch &&
        requestParentTurnId === d.getState().parentTurnId &&
        requestConfigRevision === d.refs.configRevision &&
        !parentSignalAborted(requestAbortInput) &&
        (!options.requiresEnabled || (d.currentConfig().enabled && d.currentConfig().configured)) &&
        !parentHasPendingMessages(options.ctx) &&
        d.branchContains(options.ctx, anchor) &&
        (options.trajectoryId === undefined ||
          d.getState().activeTrajectory?.id === options.trajectoryId);
      if (!requestIsCurrent()) return discardRequest();
      const verifyBlocker =
        options.source !== "last" && checkpoint.findings.some(isVerificationCandidate);
      if (verifyBlocker) {
        d.mutateMetrics((next) => {
          next.blockerVerificationAttempts = (next.blockerVerificationAttempts ?? 0) + 1;
        });
        const verificationId = `advisor-${requestEpoch}-${++d.refs.checkpointId}`;
        activeCheckpointId = verificationId;
        const verification = yield* activeQueue
          .checkpointEffect({
            checkpointId: verificationId,
            focus: "blocker-verification",
            parentTurnId: requestParentTurnId,
            verificationReview: checkpoint,
          })
          .pipe(Effect.mapError(extensionError("verification checkpoint")));
        if (!requestIsCurrent()) return discardRequest();
        const proposedBlockers = verificationFingerprints(checkpoint.findings);
        checkpoint = applyBlockerVerification(checkpoint, verification);
        const retainedBlockers = verificationFingerprints(checkpoint.findings);
        d.mutateMetrics((next) => {
          next.blockersVerified = (next.blockersVerified ?? 0) + retainedBlockers.size;
          next.blockersRejected =
            (next.blockersRejected ?? 0) +
            Math.max(0, proposedBlockers.size - retainedBlockers.size);
        });
      }
      finishReviewDuration();
      if (!requestIsCurrent()) {
        d.mutateMetrics((next) => {
          next.lastAction = "discarded";
        });
        return discardRequest();
      }

      d.refs.latestStateSummary = checkpoint.stateSummary;
      d.refs.latestDurableSummary = summarizeAdvisorReview(checkpoint);
      d.deliver(
        checkpoint,
        options.phase,
        options.source,
        options.ctx,
        requestAbortInput,
        ledgerScope,
        requestCancellationEpoch,
        options.abortOnBlocker ? options.trajectoryId : undefined,
      );
      d.refs.runtimeCursor = { anchor, fingerprint: d.fingerprint() };
      d.persistLedger(anchor);
      outcomeRecorded = true;
      return "completed" as const;
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          finishReviewDuration();
          if (requestEpoch !== d.getState().epoch || !validForDelivery) return discardRequest();
          outcomeRecorded = true;
          const kind = classifyFailure(error);
          d.mutateMetrics((next) => {
            next.failure += 1;
            next.outcomes.failures += 1;
            next.lastAction = "failure";
            next.lastFailureKind = kind;
          });
          const failureDetails = (() => {
            const objectPart10776_0 = {
              contextChars: activeQueue?.backlog ?? 0,
              durationMs: d.getState().metrics.latestDurationMs ?? 0,
              error,
            };
            const objectPart10776_1 = d.currentConfig().model
              ? { ...objectPart10776_0, model: d.currentConfig().model }
              : objectPart10776_0;
            const objectPart10776_2 = d.currentConfig().provider
              ? { ...objectPart10776_1, provider: d.currentConfig().provider }
              : objectPart10776_1;
            const objectPart10776_3 = {
              ...objectPart10776_2,
              timeoutMs: ADVISOR_OPERATION_TIMEOUT_MS,
            };
            return objectPart10776_3;
          })();
          yield* Effect.forkIn(
            d.failureLogger.log(d.currentConfig().configPath, failureDetails),
            d.applicationScope,
          );
          d.setAdvisorStatus(options.ctx, "advisor: unavailable");
          if (!d.getState().reportedFailures.includes(kind)) {
            d.updateApplicationState((state) => ({
              ...state,
              reportedFailures: [...state.reportedFailures, kind],
            }));
            d.notifyBestEffort(
              options.ctx,
              `Advisor ${kind} failure; keeping the primary response. See the Advisor failure log.`,
              "warning",
            );
          }
          if (kind === "authentication") void d.stopRuntime();
          return "failed" as const;
        }),
      ),
      Effect.withSpan("pi-advisor.parent.checkpoint"),
    );
    const invalidate = () => {
      validForDelivery = false;
    };
    const cancel = Effect.suspend(() => {
      const targetQueue = activeQueue;
      const targetId = activeCheckpointId;
      return targetQueue && targetId ? targetQueue.cancelCheckpointEffect(targetId) : Effect.void;
    });
    const finalizeCancellation = () => {
      finishReviewDuration();
      discardRequest();
    };
    const orchestrated = d.checkpointOrchestrator.start(checkpointSettlement, {
      invalidate,
      finalizeCancellation,
      cancelActive: cancel,
    });
    return {
      abortInput: requestAbortInput,
      invalidate: orchestrated.invalidate,
      cancelEffect: orchestrated.cancelEffect,
      settlement: orchestrated.settlement.pipe(
        Effect.map(
          Exit.match({
            onFailure: () => "failed" as const,
            onSuccess: (value) => value,
          }),
        ),
      ),
    };
  };

  const awaitCatchUpEffectOwned = (
    handle: AdvisorCheckpointHandle,
    ctx: ExtensionContext,
  ): Effect.Effect<void> =>
    Effect.suspend(() => {
      d.mutateMetrics((next) => {
        next.catchUpWaits = incrementBounded(next.catchUpWaits);
        next.activeCatchUpWaits = incrementBounded(next.activeCatchUpWaits);
      });
      const recordTimeout = () => {
        d.mutateMetrics((next) => {
          next.catchUpTimeouts = incrementBounded(next.catchUpTimeouts);
        });
      };
      let cancellationRecorded = false;
      const recordCancellation = () => {
        if (cancellationRecorded) return;
        cancellationRecorded = true;
        handle.invalidate();
        d.advanceDomainCounter("cancellationEpoch");
        d.latchCancellation();
        d.clearPendingRecovery();
        d.clearPendingReceipt();
        d.persistCurrentLedger(ctx);
        d.mutateMetrics((next) => {
          next.catchUpCancellations = incrementBounded(next.catchUpCancellations);
        });
      };
      const cancellation = Effect.callback<"cancelled", AdvisorHostContextError>((resume) => {
        const registered = registerAdvisorAbortListenerAtHostBoundary(handle.abortInput, () => {
          try {
            recordCancellation();
          } finally {
            try {
              resume(handle.cancelEffect.pipe(Effect.as("cancelled" as const)));
            } catch {
              /* Effect callback resumption cannot escape the native abort listener */
            }
          }
        });
        if (!registered.ok) {
          resume(Effect.fail(registered.error));
          return;
        }
        return Effect.sync(registered.registration.remove);
      }).pipe(
        Effect.catch(() =>
          Effect.sync(recordCancellation).pipe(
            Effect.andThen(handle.cancelEffect),
            Effect.as("cancelled" as const),
          ),
        ),
      );
      return awaitAdvisorCatchUpEffect(
        handle.settlement,
        d.catchUpTimeoutMs,
        cancellation,
        Effect.sync(recordTimeout).pipe(Effect.andThen(handle.cancelEffect)),
      ).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            if (outcome === "failed") {
              d.mutateMetrics((next) => {
                next.catchUpFailures = incrementBounded(next.catchUpFailures);
              });
            }
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            d.mutateMetrics((next) => {
              next.activeCatchUpWaits = Math.max(0, (next.activeCatchUpWaits ?? 1) - 1);
            });
          }),
        ),
        Effect.asVoid,
      );
    });
  const awaitCatchUp = (handle: AdvisorCheckpointHandle, ctx: ExtensionContext): Promise<void> =>
    d.runSessionEffect(awaitCatchUpEffectOwned(handle, ctx));

  return { requestCheckpoint, awaitCatchUpEffectOwned, awaitCatchUp };
};
