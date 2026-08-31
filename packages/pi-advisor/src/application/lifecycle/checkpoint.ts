/** Checkpoint request and catch-up wait controls. */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CheckpointOrchestratorContract } from "../../checkpoint/orchestrator.ts";
import {
  captureAdvisorAbortInputAtHostBoundary,
  registerAdvisorAbortListenerAtHostBoundary,
  type AdvisorHostContextError,
} from "../../boundary/host-context.ts";
import { ADVISOR_OPERATION_TIMEOUT_MS, type ResolvedAdvisorConfig } from "../../config/options.ts";
import { classifyFailure } from "../../domain/runtime-error-classifier.ts";
import type { FailureLoggerContract } from "../../logging/logger.ts";
import type { AdvisorReviewQueue } from "../../queue/review-queue.ts";
import { summarizeAdvisorReview } from "../../checkpoint/ledger.ts";
import { applyBlockerVerification, isVerificationCandidate } from "../../review/finding-gates.ts";
import type { AdvisorReviewFocus } from "../../review/schema.ts";
import {
  awaitAdvisorCatchUpEffect,
  type AdvisorCheckpointHandle,
  type CheckpointSettlement,
  type ParentAnchor,
  type ReviewPhase,
  type ReviewSource,
} from "../controller.ts";
import type { AdvisorApplicationState } from "../state.ts";
import type { DeliverFn } from "./delivery.ts";
import { parentHasPendingMessages, parentSignalAborted } from "./parent-session.ts";

export interface CheckpointRefs {
  queue: AdvisorReviewQueue | undefined;
  runtimeCursor: { anchor: ParentAnchor; fingerprint: string } | undefined;
  checkpointId: number;
  latestStateSummary: string;
  latestDurableSummary: ReturnType<typeof summarizeAdvisorReview>;
}

export interface CheckpointDeps {
  readonly refs: CheckpointRefs;
  readonly getState: () => AdvisorApplicationState;
  readonly updateApplicationState: (
    update: (state: AdvisorApplicationState) => AdvisorApplicationState,
  ) => void;
  readonly updateMetrics: (
    update: (metrics: AdvisorApplicationState["metrics"]) => AdvisorApplicationState["metrics"],
  ) => void;
  readonly currentConfig: () => ResolvedAdvisorConfig;
  readonly cancelRequest: () => void;
  readonly persistCurrentLedger: (ctx: ExtensionContext) => void;
  readonly persistLedger: (anchor: ParentAnchor) => void;
  readonly notifyBestEffort: CheckpointNotify;
  readonly setAdvisorStatus: (ctx: ExtensionContext, text?: string) => void;
  readonly failureLogger: FailureLoggerContract;
  readonly applicationScope: Scope.Scope;
  readonly checkpointOrchestrator: CheckpointOrchestratorContract;
  readonly now: () => number;
  readonly startRuntimeEffect: (
    ctx: ExtensionContext,
    restoration?: "preserve-live" | "restore-branch",
    allowDisabled?: boolean,
  ) => Effect.Effect<number | undefined>;
  readonly stopRuntimeEffect: () => Effect.Effect<void>;
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

interface CheckpointOwnerGeneration {
  readonly epoch: number;
  readonly cancellationEpoch: number;
  readonly parentTurnId: number;
  readonly requestSequence: number;
  readonly anchor: ParentAnchor;
  readonly queue: AdvisorReviewQueue;
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
    if (!d.refs.queue && (!d.currentConfig().enabled || !d.currentConfig().configured)) {
      return undefined;
    }
    const admissionState = d.getState();
    const admission: Pick<
      CheckpointOwnerGeneration,
      "cancellationEpoch" | "parentTurnId" | "requestSequence" | "anchor"
    > = {
      cancellationEpoch: admissionState.cancellationEpoch,
      parentTurnId: admissionState.parentTurnId,
      requestSequence: admissionState.requestSequence,
      anchor: d.parentAnchor(options.ctx),
    };
    let validForDelivery = true;
    let activeQueue: AdvisorReviewQueue | undefined;
    let activeCheckpointId: string | undefined;
    let ownerGeneration: CheckpointOwnerGeneration | undefined;
    const ledgerScope = d.lifecycleScope(options.ctx);
    const startedAt = d.now();
    let reviewSettled = false;
    const settleReview = (settlement: CheckpointSettlement): CheckpointSettlement => {
      if (reviewSettled) return settlement;
      reviewSettled = true;
      d.updateApplicationState((state) => ({
        ...state,
        metrics: d.recordReviewDuration(state.metrics, startedAt),
      }));
      return settlement;
    };
    const discardRequest = (): CheckpointSettlement => settleReview("discarded");
    const admissionIsCurrent = (state: AdvisorApplicationState = d.getState()): boolean => {
      return (
        validForDelivery &&
        admission.cancellationEpoch === state.cancellationEpoch &&
        admission.parentTurnId === state.parentTurnId &&
        admission.requestSequence === state.requestSequence &&
        !parentSignalAborted(requestAbortInput) &&
        (!options.requiresEnabled || (state.config.enabled && state.config.configured)) &&
        d.branchContains(options.ctx, admission.anchor) &&
        (options.trajectoryId === undefined || state.activeTrajectory?.id === options.trajectoryId)
      );
    };
    const requestIsCurrent = (): boolean => {
      const owner = ownerGeneration;
      if (!owner) return false;
      const state = d.getState();
      return (
        admissionIsCurrent(state) &&
        !parentHasPendingMessages(options.ctx) &&
        owner.queue === d.refs.queue &&
        owner.epoch === state.epoch &&
        owner.cancellationEpoch === state.cancellationEpoch &&
        owner.parentTurnId === state.parentTurnId &&
        owner.requestSequence === state.requestSequence
      );
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
        if (restartEpoch === undefined || restartEpoch !== d.getState().epoch)
          return discardRequest();
      }
      if (!admissionIsCurrent() || !d.refs.queue || !d.refs.runtimeCursor) return discardRequest();
      if (
        options.trajectoryId !== undefined &&
        d.getState().activeTrajectory?.id !== options.trajectoryId
      )
        return discardRequest();

      activeQueue = d.refs.queue;
      const state = d.getState();
      const owner: CheckpointOwnerGeneration = {
        epoch: state.epoch,
        cancellationEpoch: state.cancellationEpoch,
        parentTurnId: state.parentTurnId,
        requestSequence: state.requestSequence,
        anchor: admission.anchor,
        queue: activeQueue,
      };
      ownerGeneration = owner;
      const id = `advisor-${owner.epoch}-${++d.refs.checkpointId}`;
      activeCheckpointId = id;
      let checkpoint = yield* activeQueue.checkpointEffect({
        checkpointId: id,
        focus: options.focus,
      });
      if (!requestIsCurrent()) return discardRequest();
      const verifyBlocker =
        options.source !== "last" && checkpoint.findings.some(isVerificationCandidate);
      if (verifyBlocker) {
        const verificationId = `advisor-${owner.epoch}-${++d.refs.checkpointId}`;
        activeCheckpointId = verificationId;
        const verification = yield* activeQueue.checkpointEffect({
          checkpointId: verificationId,
          focus: "blocker-verification",
          verificationReview: checkpoint,
        });
        if (!requestIsCurrent()) return discardRequest();
        checkpoint = applyBlockerVerification(checkpoint, verification);
      }
      if (!requestIsCurrent()) {
        d.updateMetrics((metrics) => ({ ...metrics, lastAction: "discarded" }));
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
        owner.cancellationEpoch,
        options.abortOnBlocker ? options.trajectoryId : undefined,
      );
      d.refs.runtimeCursor = {
        anchor: owner.anchor,
        fingerprint: d.fingerprint(),
      };
      d.persistLedger(owner.anchor);
      return settleReview("completed");
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (!requestIsCurrent()) return discardRequest();
          const kind = classifyFailure(error);
          settleReview("failed");
          d.updateMetrics((metrics) => ({ ...metrics, lastAction: "failure" }));
          const config = d.currentConfig();
          const baseDetails = {
            contextChars: activeQueue?.backlog ?? 0,
            durationMs: d.getState().metrics.latestDurationMs ?? 0,
            error,
            timeoutMs: ADVISOR_OPERATION_TIMEOUT_MS,
          };
          const withModel = config.model ? { ...baseDetails, model: config.model } : baseDetails;
          const failureDetails = config.provider
            ? { ...withModel, provider: config.provider }
            : withModel;
          yield* Effect.forkIn(
            d.failureLogger.log(config.configPath, failureDetails),
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
          if (kind === "authentication")
            yield* Effect.forkIn(d.stopRuntimeEffect(), d.applicationScope, {
              startImmediately: true,
            });
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
            onFailure: () => settleReview("failed"),
            onSuccess: (value) => settleReview(value),
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
      let cancellationRecorded = false;
      const recordCancellation = () => {
        if (cancellationRecorded) return;
        cancellationRecorded = true;
        handle.invalidate();
        d.cancelRequest();
        d.persistCurrentLedger(ctx);
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
        handle.cancelEffect,
      ).pipe(Effect.asVoid);
    });
  return { requestCheckpoint, awaitCatchUpEffectOwned };
};
