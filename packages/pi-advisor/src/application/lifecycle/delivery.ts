/** Review delivery transaction for one advisor session. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  abortAdvisorParentAtHostBoundary,
  type AdvisorAbortInput,
} from "../../boundary/host-context.ts";
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
  sendAdvisorAdvice,
  sendAdvisorPerspective,
  sendCorrection,
} from "../controller-helpers.ts";
import { parentIsIdle, parentSignalAborted } from "./parent-session.ts";

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
        next.outcomes.discarded += 1;
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
    const explicitlyRequested = source === "last";
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
      const manualSuggestion = explicitlyRequested;
      const automaticPerspective = phase === "progress" && source === "automatic-progress";
      if (!manualSuggestion && !automaticPerspective) return suppress();
      if (
        automaticPerspective &&
        !canDeliverAdvisorIntervention(d.getState().interventionBudget, "concern")
      )
        return suppress();
      const suggestion = manualSuggestion
        ? review.suggestions?.[0]
        : selectAdvisorPerspective(d.getState().perspectiveBudget, review.suggestions ?? []);
      if (!suggestion) {
        if (explicitlyRequested)
          d.notifyBestEffort(ctx, "Advisor found no useful suggestion.", "info");
        return suppress();
      }
      if (deliveryCancelled()) return discardAtDeliveryBoundary();
      const perspectiveReview: AdvisorReview = {
        verdict: "suggest",
        summary: review.summary,
        suggestions: [suggestion],
        findings: [],
      };
      const published = manualSuggestion
        ? { ...sendAdvisorAdvice(d.pi, perspectiveReview), guidanceSent: false }
        : sendAdvisorPerspective(d.pi, perspectiveReview);
      if (!published.appended) {
        d.notifyBestEffort(ctx, "Advisor could not show its suggestion card.", "warning");
        return suppress();
      }
      if (automaticPerspective)
        d.updateApplicationState((state) => ({
          ...state,
          perspectiveBudget: commitAdvisorPerspective(state.perspectiveBudget, suggestion),
          // A perspective is the request's ordinary visible intervention; only a
          // later verified blocker may escalate after it.
          interventionBudget: commitAdvisorIntervention(state.interventionBudget, "concern", false),
        }));
      d.mutateMetrics((next) => {
        if (manualSuggestion) {
          next.outcomes.advice += 1;
          next.lastAction = "advice";
        } else {
          next.outcomes.perspective += 1;
          next.perspectivesDelivered = incrementBounded(next.perspectivesDelivered);
          next.lastAction = "perspective";
        }
        next.cards = incrementBounded(next.cards);
      });
      if (published.guidanceSent)
        d.ingest({
          type: "advisor_intervention",
          findingIds: [],
          action: "perspective",
          requestSequence: d.getState().requestSequence,
        });
      else if (automaticPerspective)
        d.notifyBestEffort(
          ctx,
          "Advisor showed a suggestion locally but could not steer the active agent.",
          "warning",
        );
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
        next.outcomes.pass += 1;
        next.lastAction = "pass";
      });
      if (explicitlyRequested) d.notifyBestEffort(ctx, "Advisor found no issues.", "info");
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
    if (filtered.findings.length === 0) {
      if (explicitlyRequested) d.notifyBestEffort(ctx, "Advisor found no new issues.", "info");
      return suppress();
    }
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
      if (explicitlyRequested) d.notifyBestEffort(ctx, "Advisor found no new issues.", "info");
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
    const budgeted = !explicitlyRequested;
    if (budgeted && !canDeliverAdvisorIntervention(d.getState().interventionBudget, severity)) {
      rollbackUndelivered(emission);
      return suppress();
    }
    let route: AdvisorRoute = explicitlyRequested
      ? "push-direct"
      : routeAdvisorFinding({
          severity,
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

    // Cancellation is synchronous and wins over a provider completion queued in
    // the same tick. Recheck at the exact delivery boundary before every send path.
    if (deliveryCancelled()) {
      rollbackUndelivered(emission);
      return discardAtDeliveryBoundary();
    }
    const findingIds = filteredReview.findings.flatMap((finding) =>
      finding.id ? [finding.id] : [],
    );
    const commitPresentation = (
      correction: boolean,
      outcome: "advice" | "guidance" | "revision",
      parentGuidance: boolean,
      commitBudget = budgeted,
    ): void => {
      d.updateApplicationState((state) => ({
        ...state,
        findingLifecycle: parentGuidance
          ? acknowledgeAdvisorFindings(state.findingLifecycle, findingIds)
          : state.findingLifecycle,
        interventionBudget: commitBudget
          ? commitAdvisorIntervention(state.interventionBudget, severity, correction)
          : state.interventionBudget,
      }));
      if (!parentGuidance) return;
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
    };
    const recordCard = (): void =>
      d.mutateMetrics((next) => {
        next.cards = incrementBounded(next.cards);
      });
    const publishLocalCard = (commitBudget = budgeted): boolean => {
      const published = sendAdvisorAdvice(d.pi, filteredReview);
      if (!published.appended) return false;
      commitPresentation(false, "advice", false, commitBudget);
      recordCard();
      return true;
    };
    const publishCorrection = (
      outcome: "guidance" | "revision",
      triggerTurn: boolean,
      commitBudget = budgeted,
    ) => {
      const published = sendCorrection(d.pi, filteredReview, triggerTurn);
      if (published.appended) recordCard();
      if (published.appended || published.guidanceSent)
        commitPresentation(
          published.guidanceSent,
          published.guidanceSent ? outcome : "advice",
          published.guidanceSent,
          commitBudget,
        );
      if (!published.appended)
        d.notifyBestEffort(ctx, "Advisor could not show its review card.", "warning");
      if (!published.guidanceSent)
        d.notifyBestEffort(
          ctx,
          published.appended
            ? "Advisor showed the issue locally but could not send correction guidance."
            : "Advisor could not deliver its correction.",
          "warning",
        );
      return published;
    };
    if (route === "silent") {
      rollbackUndelivered(emission);
      return suppress();
    } else if (route === "push-direct") {
      if (!publishLocalCard()) {
        rollbackUndelivered(emission);
        d.notifyBestEffort(ctx, "Advisor could not show its review card.", "warning");
        return suppress();
      }
      d.mutateMetrics((next) => {
        next.lastAction = "advice";
      });
    } else if (route === "steer-live" || route === "trigger-correction") {
      const outcome = phase === "progress" ? "guidance" : "revision";
      const published = publishCorrection(outcome, route === "trigger-correction");
      if (!published.appended && !published.guidanceSent) {
        rollbackUndelivered(emission);
        return suppress();
      }
      if (published.guidanceSent)
        d.updateApplicationState((state) => ({
          ...state,
          routing: armAdvisorInterruption(state.routing),
        }));
      else route = "push-direct";
      d.mutateMetrics((next) => {
        next.lastAction = published.guidanceSent ? outcome : "advice";
      });
    } else {
      if (!trajectory || trajectoryId === undefined) {
        if (!publishLocalCard()) {
          rollbackUndelivered(emission);
          return suppress();
        }
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
          phase,
          epoch: state.epoch,
          parentTurnId: state.parentTurnId,
          configRevision: d.getConfigRevision(),
          cancellationEpoch: state.cancellationEpoch,
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
          interventionBudget: budgetBefore,
        }));
        const published = publishCorrection("guidance", false);
        if (!published.appended && !published.guidanceSent) {
          rollbackUndelivered(emission);
          d.notifyBestEffort(ctx, abortResult.error.message, "warning");
          return suppress();
        }
        if (published.guidanceSent)
          d.updateApplicationState((state) => ({
            ...state,
            routing: armAdvisorInterruption(state.routing),
          }));
        d.mutateMetrics((next) => {
          next.lastAction = published.guidanceSent ? "guidance" : "advice";
        });
        d.notifyBestEffort(ctx, abortResult.error.message, "warning");
        return published.guidanceSent ? "steer-live" : "push-direct";
      }
    }
    return route;
  };
