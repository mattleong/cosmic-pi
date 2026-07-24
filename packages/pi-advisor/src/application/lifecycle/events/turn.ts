import * as Effect from "effect/Effect";
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
import {
  reviewWithAcknowledgedFindings,
  sendTriggeredCorrection,
} from "../../controller-helpers.ts";
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
      d.isPaused() ||
      !d.currentConfig().configured ||
      signalAborted ||
      !parentIsIdle(ctx) ||
      parentHasPendingMessages(ctx)
    ) {
      d.clearPendingRecovery();
      return;
    }
    d.updateApplicationState((state) => ({
      ...state,
      pendingPersistentRecovery: undefined,
      abortInProgress: undefined,
      findingLifecycle: acknowledgeAdvisorFindings(state.findingLifecycle, recovery.findingIds),
    }));
    sendTriggeredCorrection(
      d.pi,
      recovery.config,
      reviewWithAcknowledgedFindings(recovery.review, recovery.findingIds),
      recovery.phase,
      recovery.recovering,
    );
    d.mutateMetrics((next) => {
      next.outcomes.recovery += 1;
      next.interventionsDelivered = (next.interventionsDelivered ?? 0) + 1;
    });
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
      if (stopReason !== "stop" && trajectory)
        d.mutateTrajectory(trajectory.id, (current) => ({ ...current, abortAllowed: false }));
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
    const explicitlyRequested = classification.phase === "final" && d.getState().reviewNext;
    if (explicitlyRequested) {
      d.updateApplicationState((state) => ({ ...state, reviewNext: false }));
      return d.runSessionEffect(
        d
          .runWithExplicitRuntimeEffect(ctx, () =>
            d.requestCheckpoint({
              ctx,
              focus: "standard",
              phase: "final",
              source: "next",
              requiresEnabled: false,
            }),
          )
          .pipe(
            Effect.flatMap((handle) =>
              handle ? d.awaitCatchUpEffectOwned(handle, ctx) : Effect.void,
            ),
          ),
      );
    }
    if (!d.currentConfig().enabled) {
      d.recordSkip("disabled");
      return;
    }
    if (d.isPaused()) {
      d.recordSkip("session-paused");
      return;
    }
    if (!d.currentConfig().configured) {
      d.recordSkip("unconfigured");
      return;
    }
    const perspectiveCheckpoint =
      classification.phase === "progress" && !refs.perspectiveCheckpointUsed;
    const handle = d.requestCheckpoint({
      ctx,
      focus:
        classification.phase === "progress"
          ? perspectiveCheckpoint
            ? "perspective"
            : "observation"
          : "standard",
      phase: classification.phase,
      source:
        classification.phase === "progress"
          ? perspectiveCheckpoint
            ? "automatic-perspective"
            : "automatic-catch-up"
          : "automatic-final",
      requiresEnabled: true,
    });
    if (handle && perspectiveCheckpoint) refs.perspectiveCheckpointUsed = true;
    return handle ? d.awaitCatchUp(handle, ctx) : undefined;
  });
};
