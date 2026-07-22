/** Review delivery transaction for one advisor session. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  abortAdvisorParentAtHostBoundary,
  type AdvisorAbortInput,
} from "../../boundary/host-context.ts";
import type { ResolvedAdvisorConfig } from "../../config/options.ts";
import {
  filterAdvisorFindingsWithRollback,
  rollbackAdvisorFindingDedupe,
} from "../../review/dedupe.ts";
import {
  evaluateAdvisorEmission,
  rollbackAdvisorEmission,
  type AdvisorEmissionRollback,
} from "../../review/emission-guard.ts";
import { gateAdvisorFindings } from "../../review/finding-gates.ts";
import {
  acknowledgeAdvisorFindings,
  reconcileAdvisorFindings,
} from "../../review/finding-lifecycle.ts";
import {
  canCorrectAdvisorIntervention,
  canDeliverAdvisorIntervention,
  commitAdvisorIntervention,
} from "../../review/intervention-budget.ts";
import { type AdvisorReview } from "../../review/index.ts";
import {
  commitAdvisorPerspective,
  selectAdvisorPerspective,
} from "../../review/perspective-budget.ts";
import {
  armAdvisorInterruption,
  isAdvisorImmunityActive,
  routeAdvisorFinding,
  type AdvisorRoute,
} from "../../review/routing.ts";
import { advisorActiveToolCount } from "../../review/trajectory.ts";
import type { AdvisorCheckpoint } from "../../runtime/runtime.ts";
import type { AdvisorReviewQueue } from "../../queue/service.ts";
import type { AdvisorApplicationState } from "../state.ts";
import type { ReviewPhase, ReviewSource } from "../controller-types.ts";
import {
  incrementBounded,
  reviewWithAcknowledgedFindings,
  sendAdvisorAdvice,
  sendAdvisorPerspective,
  sendCorrection,
} from "../controller-helpers.ts";
import { parentIsIdle, parentSignalAborted } from "./host-reads.ts";

export type DeliverFn = (
  checkpoint: AdvisorCheckpoint,
  phase: ReviewPhase,
  source: ReviewSource,
  ctx: ExtensionContext,
  abortInput: AdvisorAbortInput,
  scope: string,
  expectedCancellationEpoch: number,
  trajectoryId?: number,
) => AdvisorRoute;

export interface DeliveryDeps {
  readonly pi: ExtensionAPI;
  readonly getState: () => AdvisorApplicationState;
  readonly updateApplicationState: (
    update: (state: AdvisorApplicationState) => AdvisorApplicationState,
  ) => void;
  readonly mutateMetrics: (mutate: (next: AdvisorApplicationState["metrics"]) => void) => void;
  readonly currentConfig: () => ResolvedAdvisorConfig;
  readonly ingest: (input: Parameters<AdvisorReviewQueue["ingest"]>[1]) => void;
  readonly recordReceipt: (ids: readonly string[]) => void;
  readonly notifyBestEffort: (
    ctx: Pick<ExtensionContext, "ui">,
    message: string,
    level: "info" | "warning" | "error",
  ) => void;
  readonly getConfigRevision: () => number;
}

export const makeDeliver =
  (d: DeliveryDeps): DeliverFn =>
  (
    checkpoint: AdvisorCheckpoint,
    phase: ReviewPhase,
    source: ReviewSource,
    ctx: ExtensionContext,
    abortInput: AdvisorAbortInput,
    scope: string,
    expectedCancellationEpoch: number,
    trajectoryId?: number,
  ): AdvisorRoute => {
    const discardAtDeliveryBoundary = (): AdvisorRoute => {
      d.mutateMetrics((next) => {
        next.discarded += 1;
        if (source !== "automatic-catch-up") next.outcomes.discarded += 1;
        next.lastAction = "discarded";
      });
      return "silent";
    };
    const deliveryCancelled = () =>
      parentSignalAborted(abortInput) ||
      expectedCancellationEpoch !== d.getState().cancellationEpoch;
    if (deliveryCancelled()) return discardAtDeliveryBoundary();
    const review: AdvisorReview = {
      verdict: checkpoint.verdict,
      summary: checkpoint.summary,
      suggestions: checkpoint.suggestions ?? [],
      findings: checkpoint.findings,
    };
    const suppress = (lastAction: "suppressed" | "pass" = "suppressed"): "silent" => {
      d.mutateMetrics((next) => {
        next.outcomes.suppressed += 1;
        next.lastAction = lastAction;
      });
      return "silent";
    };
    if (review.verdict === "suggest") {
      d.mutateMetrics((next) => {
        next.suggest = incrementBounded(next.suggest);
      });
      if (
        phase !== "progress" ||
        source === "automatic-catch-up" ||
        source === "last" ||
        source === "verify"
      ) {
        return suppress();
      }
      const suggestion = selectAdvisorPerspective(
        d.getState().perspectiveBudget,
        review.suggestions ?? [],
      );
      if (!suggestion) return suppress();
      if (deliveryCancelled()) return discardAtDeliveryBoundary();
      const perspectiveReview: AdvisorReview = {
        verdict: "suggest",
        summary: review.summary,
        suggestions: [suggestion],
        findings: [],
      };
      d.updateApplicationState((state) => ({
        ...state,
        perspectiveBudget: commitAdvisorPerspective(state.perspectiveBudget, suggestion),
      }));
      sendAdvisorPerspective(d.pi, d.currentConfig(), perspectiveReview);
      d.mutateMetrics((next) => {
        next.outcomes.perspective += 1;
        next.perspectivesDelivered = incrementBounded(next.perspectivesDelivered);
        next.lastAction = "perspective";
      });
      d.ingest({
        type: "advisor_intervention",
        findingIds: [],
        action: "perspective",
        requestSequence: d.getState().requestSequence,
      });
      return "push-direct";
    }
    if (review.verdict === "pass") {
      if (phase === "final") {
        d.updateApplicationState((state) => ({
          ...state,
          findingLifecycle: reconcileAdvisorFindings(state.findingLifecycle, [], {
            scope,
            completedTurn: state.routing.completedPrimaryTurns,
            complete: true,
          }).state,
        }));
      }
      d.mutateMetrics((next) => {
        next.pass += 1;
        if (source !== "automatic-catch-up") next.outcomes.pass += 1;
        next.lastAction = "pass";
      });
      return "silent";
    }
    // Tool-calling turn boundaries keep the persistent Advisor caught up, but
    // they are not completed responses and must never emit "unfinished work"
    // critiques. Explicit trajectory checkpoints remain independently routable.
    if (source === "automatic-catch-up") {
      d.mutateMetrics((next) => {
        next.suppressedFindings = (next.suppressedFindings ?? 0) + review.findings.length;
        next.lastAction = "suppressed";
      });
      return "silent";
    }
    d.mutateMetrics((next) => {
      next.outcomes.findings += 1;
    });
    const gated = gateAdvisorFindings(review.findings);
    d.mutateMetrics((next) => {
      next.suppressedFindings = (next.suppressedFindings ?? 0) + gated.suppressed;
    });
    const lifecycle = reconcileAdvisorFindings(d.getState().findingLifecycle, gated.actionable, {
      scope,
      completedTurn: d.getState().routing.completedPrimaryTurns,
      complete: phase === "final",
    });
    const filtered = filterAdvisorFindingsWithRollback(
      d.getState().findingDedupe,
      lifecycle.findings.filter((finding) => finding.status === "open"),
      scope,
    );
    d.updateApplicationState((state) => ({
      ...state,
      findingLifecycle: lifecycle.state,
      findingDedupe: filtered.state,
    }));
    d.mutateMetrics((next) => {
      next.suppressedFindings = (next.suppressedFindings ?? 0) + filtered.suppressed;
    });
    if (filtered.findings.length === 0) return suppress();
    const filteredReview = { ...review, findings: filtered.findings };
    const rollbackUndelivered = (emission?: { rollback: AdvisorEmissionRollback }): void => {
      d.updateApplicationState((state) => ({
        ...state,
        findingDedupe: rollbackAdvisorFindingDedupe(state.findingDedupe, filtered.rollback),
        emissionGuard: emission
          ? rollbackAdvisorEmission(state.emissionGuard, emission.rollback)
          : state.emissionGuard,
      }));
    };
    const emissionResult = evaluateAdvisorEmission(
      d.getState().emissionGuard,
      checkpoint.checkpointId,
      filteredReview,
    );
    d.updateApplicationState((state) => ({ ...state, emissionGuard: emissionResult.state }));
    const emission = emissionResult.decision;
    if (!emission.accepted) {
      rollbackUndelivered();
      return suppress(emission.reason === "pass" ? "pass" : "suppressed");
    }
    d.mutateMetrics((next) => {
      next.revise += 1;
    });
    const { severity } = emission;
    const currentState = d.getState();
    const trajectory =
      trajectoryId !== undefined && currentState.activeTrajectory?.id === trajectoryId
        ? currentState.activeTrajectory
        : undefined;
    const aborting = Boolean(
      (currentState.abortInProgress &&
        currentState.abortInProgress.epoch === currentState.epoch &&
        currentState.abortInProgress.parentTurnId === currentState.parentTurnId &&
        currentState.abortInProgress.cancellationEpoch === currentState.cancellationEpoch) ||
      (currentState.pendingPersistentRecovery &&
        currentState.pendingPersistentRecovery.epoch === currentState.epoch &&
        currentState.pendingPersistentRecovery.parentTurnId === currentState.parentTurnId &&
        currentState.pendingPersistentRecovery.cancellationEpoch ===
          currentState.cancellationEpoch),
    );
    const historicalManual = source === "last" || source === "verify";
    const explicitManual = historicalManual || source === "next";
    const budgeted = !explicitManual;
    if (budgeted && !canDeliverAdvisorIntervention(d.getState().interventionBudget, severity)) {
      rollbackUndelivered(emission);
      return suppress();
    }
    let route = explicitManual
      ? severity === "nit"
        ? "silent"
        : "push-direct"
      : routeAdvisorFinding({
          severity,
          policy: d.currentConfig().reviewPolicy,
          parentState: aborting
            ? "aborting"
            : parentIsIdle(ctx)
              ? phase === "final"
                ? "final"
                : "idle"
              : "active",
          immunityActive: isAdvisorImmunityActive(d.getState().routing),
          cancellationLatched: d.getState().routing.cancellationLatched,
          sameTurnStrongSignal:
            severity === "blocker" &&
            Boolean(
              trajectory?.loopConfirmed && trajectory.generation === d.getState().parentTurnId,
            ),
          abortSafe: Boolean(
            trajectory?.abortAllowed && advisorActiveToolCount(trajectory.toolDetector) === 0,
          ),
        });
    const correctionRoute =
      route === "steer-live" || route === "trigger-correction" || route === "abort-recover";
    if (
      budgeted &&
      correctionRoute &&
      !canCorrectAdvisorIntervention(d.getState().interventionBudget)
    )
      route = "push-direct";
    if (budgeted && route === "push-direct" && parentIsIdle(ctx)) route = "silent";

    // Cancellation is synchronous and wins over a provider completion queued in
    // the same tick. Recheck at the exact delivery boundary before every send path.
    if (deliveryCancelled()) {
      rollbackUndelivered(emission);
      return discardAtDeliveryBoundary();
    }
    const findingIds = filteredReview.findings.flatMap((finding) =>
      finding.id ? [finding.id] : [],
    );
    const recordDelivery = (
      correction: boolean,
      outcome: "advice" | "guidance" | "revision",
      commitBudget = budgeted,
    ): AdvisorReview => {
      d.updateApplicationState((state) => ({
        ...state,
        findingLifecycle: acknowledgeAdvisorFindings(state.findingLifecycle, findingIds),
        interventionBudget: commitBudget
          ? commitAdvisorIntervention(state.interventionBudget, severity, correction)
          : state.interventionBudget,
      }));
      d.recordReceipt(findingIds);
      d.ingest({
        type: "advisor_intervention",
        findingIds,
        action: outcome,
        requestSequence: d.getState().requestSequence,
      });
      d.mutateMetrics((next) => {
        next.outcomes[outcome] += 1;
        next.interventionsDelivered = (next.interventionsDelivered ?? 0) + 1;
      });
      return reviewWithAcknowledgedFindings(filteredReview, findingIds);
    };
    const pushAdvice = (commitBudget = budgeted): void => {
      sendAdvisorAdvice(d.pi, d.currentConfig(), recordDelivery(false, "advice", commitBudget));
    };
    if (route === "silent") {
      rollbackUndelivered(emission);
      suppress();
    } else if (route === "push-direct") {
      pushAdvice();
      d.mutateMetrics((next) => {
        next.lastAction = "advice";
      });
    } else if (route === "steer-live" || route === "trigger-correction") {
      const outcome = phase === "progress" ? "guidance" : "revision";
      sendCorrection(
        d.pi,
        d.currentConfig(),
        recordDelivery(true, outcome),
        phase,
        route === "trigger-correction",
        false,
      );
      d.updateApplicationState((state) => ({
        ...state,
        routing: armAdvisorInterruption(state.routing),
      }));
      d.mutateMetrics((next) => {
        next.lastAction = outcome;
      });
    } else {
      if (!trajectory || trajectoryId === undefined) {
        pushAdvice();
        d.mutateMetrics((next) => {
          next.lastAction = "advice";
        });
        return "push-direct";
      }
      const budgetBefore = d.getState().interventionBudget;
      if (budgeted)
        d.updateApplicationState((state) => ({
          ...state,
          interventionBudget: commitAdvisorIntervention(state.interventionBudget, severity, true),
        }));
      d.updateApplicationState((state) => ({
        ...state,
        pendingPersistentRecovery: {
          review: filteredReview,
          config: { ...d.currentConfig() },
          phase,
          epoch: state.epoch,
          parentTurnId: state.parentTurnId,
          configRevision: d.getConfigRevision(),
          cancellationEpoch: state.cancellationEpoch,
          recovering: true,
          findingIds,
          budgetBefore,
          dedupeRollback: filtered.rollback,
          emission: {
            checkpointId: checkpoint.checkpointId,
            hash: emission.hash,
            rollback: emission.rollback,
          },
        },
        abortInProgress: {
          epoch: state.epoch,
          parentTurnId: state.parentTurnId,
          turnIndex: trajectory.turnIndex,
          trajectoryId,
          cancellationEpoch: state.cancellationEpoch,
        },
      }));
      d.mutateMetrics((next) => {
        next.lastAction = "recovery";
      });
      const abortResult = abortAdvisorParentAtHostBoundary(ctx);
      if (!abortResult.ok) {
        d.updateApplicationState((state) => ({
          ...state,
          pendingPersistentRecovery: undefined,
          abortInProgress: undefined,
        }));
        pushAdvice(false);
        d.mutateMetrics((next) => {
          next.lastAction = "advice";
        });
        d.notifyBestEffort(ctx, abortResult.error.message, "warning");
        return "push-direct";
      }
    }
    return route;
  };
