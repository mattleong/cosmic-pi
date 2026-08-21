import { captureAdvisorAbortInputAtHostBoundary } from "../../../boundary/host-context.ts";
import {
  assistantStopReason,
  assistantToolCalls,
  classifyReviewCheckpoint,
  contentText,
  isGenuineUserMessage,
} from "../../../domain/candidate.ts";
import { acknowledgeAdvisorFindings } from "../../../review/finding-lifecycle.ts";
import {
  armAdvisorInterruption,
  clearAdvisorCancellation,
  completeAdvisorPrimaryTurn,
} from "../../../review/routing.ts";
import { reviewWithAcknowledgedFindings, sendCorrection } from "../../controller-helpers.ts";
import { parentHasPendingMessages, parentIsIdle, parentSignalAborted } from "../parent-session.ts";
import type { EventsDeps } from "./types.ts";

export const registerTurnEvents = (d: EventsDeps): void => {
  const refs = d.refs;
  d.hostBindings.registerEvent("message_end", (event, ctx) => {
    if (!isGenuineUserMessage(event.message)) return;
    d.clearPersistentTrajectory();
    d.clearPendingRecovery();
    d.clearPendingReceipt();
    d.advanceDomainCounter("requestSequence");
    d.resetRequestDomain(false);
    d.advanceDomainCounter("cancellationEpoch");
    d.updateApplicationState((state) => ({
      ...state,
      routing: clearAdvisorCancellation(state.routing),
    }));
    d.persistCurrentLedger(ctx);
    const text = contentText(event.message);
    d.ingest({ type: "user", text: text || "[user content unavailable]" });
    refs.activeContext = ctx;
  });

  d.hostBindings.registerEvent("agent_settled", (_event, ctx) => {
    const recovery = d.getState().pendingPersistentRecovery;
    const abortCapture = captureAdvisorAbortInputAtHostBoundary(ctx);
    const signalAborted = !abortCapture.ok || parentSignalAborted(abortCapture.input);
    if (
      !recovery ||
      recovery.epoch !== d.getState().epoch ||
      recovery.parentTurnId !== d.getState().parentTurnId ||
      recovery.configRevision !== refs.configRevision ||
      recovery.cancellationEpoch !== d.getState().cancellationEpoch ||
      !d.currentConfig().enabled ||
      !d.currentConfig().configured ||
      signalAborted ||
      !parentIsIdle(ctx) ||
      parentHasPendingMessages(ctx)
    ) {
      d.clearPendingRecovery();
      return;
    }
    const published = sendCorrection(
      d.pi,
      reviewWithAcknowledgedFindings(recovery.review, recovery.findingIds),
      true,
    );
    if (!published.guidanceSent) {
      if (published.appended)
        d.mutateMetrics((next) => {
          next.cards = (next.cards ?? 0) + 1;
        });
      d.clearPendingRecovery();
      d.notifyBestEffort(
        ctx,
        published.appended
          ? "Advisor showed the recovery issue locally but could not restart the agent."
          : "Advisor could not deliver recovery guidance.",
        "warning",
      );
      return;
    }
    d.updateApplicationState((state) => ({
      ...state,
      pendingPersistentRecovery: undefined,
      abortInProgress: undefined,
      findingLifecycle: acknowledgeAdvisorFindings(state.findingLifecycle, recovery.findingIds),
    }));
    d.mutateMetrics((next) => {
      next.outcomes.recovery += 1;
      next.interventionsDelivered = (next.interventionsDelivered ?? 0) + 1;
      if (published.appended) next.cards = (next.cards ?? 0) + 1;
    });
    if (!published.appended)
      d.notifyBestEffort(
        ctx,
        "Advisor recovered the agent but could not show its review card.",
        "warning",
      );
    d.recordReceipt(recovery.findingIds);
    d.ingest({
      type: "advisor_intervention",
      findingIds: recovery.findingIds,
      action: "recovery",
      requestSequence: d.getState().requestSequence,
    });
    d.updateApplicationState((state) => ({
      ...state,
      routing: armAdvisorInterruption(state.routing),
    }));
    d.persistLedger(d.parentAnchor(ctx));
  });

  d.hostBindings.registerEvent("turn_end", (event, ctx) => {
    const trajectory = d.getState().activeTrajectory;
    d.clearPersistentTrajectory();
    const classification = classifyReviewCheckpoint(event);
    const stopReason = assistantStopReason(event.message);
    if (classification.eligible) {
      d.ingest({
        type: "assistant_final",
        text: classification.candidate,
        toolCalls: assistantToolCalls(event.message),
      });
    }
    d.ingest({ type: "turn_complete", status: stopReason });
    if (stopReason === "stop")
      d.updateApplicationState((state) => ({
        ...state,
        routing: completeAdvisorPrimaryTurn(state.routing),
      }));
    if (!classification.eligible) {
      d.recordSkip(classification.reason === "empty" ? "empty" : "incomplete");
      // No trajectory mutation here: clearPersistentTrajectory() above already removed
      // the active trajectory, and delivery treats a missing trajectory as abort-unsafe,
      // so a mutateTrajectory(trajectory.id, ...) call would be a guaranteed no-op.
      if (stopReason === "aborted") {
        const provenance = d.getState().abortInProgress;
        const matchingAdvisorAbort = Boolean(
          provenance &&
          provenance.epoch === d.getState().epoch &&
          provenance.parentTurnId === d.getState().parentTurnId &&
          provenance.cancellationEpoch === d.getState().cancellationEpoch &&
          provenance.turnIndex === event.turnIndex &&
          trajectory?.id === provenance.trajectoryId,
        );
        if (matchingAdvisorAbort) {
          d.updateApplicationState((state) => ({ ...state, abortInProgress: undefined }));
        } else {
          d.clearPendingRecovery();
          d.latchCancellation();
          d.advanceDomainCounter("cancellationEpoch");
          d.persistCurrentLedger(ctx);
        }
      }
      return;
    }
    if (classification.phase === "final") {
      refs.lastCandidate = { candidate: classification.candidate };
      d.updateApplicationState((state) => ({ ...state, hasLastCandidate: true }));
    }
    if (!d.currentConfig().enabled) {
      d.recordSkip("disabled");
      return;
    }
    if (!d.currentConfig().configured) {
      d.recordSkip("unconfigured");
      return;
    }
    // Tool-calling/progress boundaries are observation-only. They must neither
    // checkpoint the Advisor nor delay the parent agent.
    if (classification.phase === "progress") return;
    const handle = d.requestCheckpoint({
      ctx,
      focus: "standard",
      phase: "final",
      source: "automatic-final",
      requiresEnabled: true,
    });
    if (!handle) return;
    return d.awaitCatchUp(handle, ctx);
  });
};
