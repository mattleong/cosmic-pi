import type {
  AgentSettledEvent,
  ExtensionContext,
  MessageEndEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { captureAdvisorAbortInputAtHostBoundary } from "../../../boundary/host-context.ts";
import { sendCorrection } from "../../../boundary/host-review-cards.ts";
import {
  assistantStopReason,
  assistantToolCalls,
  classifyReviewCheckpoint,
  contentText,
  isGenuineUserMessage,
} from "../../../domain/candidate.ts";
import { incrementBounded } from "../../../domain/metrics.ts";
import { completeAdvisorPrimaryTurn } from "../../../review/routing.ts";
import { settleAdvisorPendingRecovery } from "../../state.ts";
import { parentHasPendingMessages, parentIsIdle, parentSignalAborted } from "../parent-session.ts";
import type { EventsDeps } from "./types.ts";

export const makeTurnEventHandlers = (d: EventsDeps) => {
  const refs = d.refs;

  const messageEnd = (event: MessageEndEvent, ctx: ExtensionContext): Effect.Effect<void> => {
    if (!isGenuineUserMessage(event.message)) return Effect.void;
    d.clearPersistentTrajectoryResources();
    d.beginUserRequest();
    d.persistCurrentLedger(ctx);
    const text = contentText(event.message);
    d.ingest({ type: "user", text: text || "[user content unavailable]" });
    refs.activeContext = ctx;
    return Effect.void;
  };

  const agentSettled = (_event: AgentSettledEvent, ctx: ExtensionContext): Effect.Effect<void> => {
    const recovery = d.getState().pendingPersistentRecovery;
    if (!recovery) return Effect.void;
    const settle = (outcome: "guidance" | "card-only" | "none"): boolean => {
      let accepted = false;
      d.updateApplicationState((state) => {
        const next = settleAdvisorPendingRecovery(state, recovery, outcome);
        accepted = next !== state;
        return next;
      });
      if (accepted) d.persistLedger(d.parentAnchor(ctx));
      return accepted;
    };
    const abortCapture = captureAdvisorAbortInputAtHostBoundary(ctx);
    const signalAborted = !abortCapture.ok || parentSignalAborted(abortCapture.input);
    if (
      recovery.epoch !== d.getState().epoch ||
      recovery.parentTurnId !== d.getState().parentTurnId ||
      recovery.cancellationEpoch !== d.getState().cancellationEpoch ||
      !d.currentConfig().enabled ||
      !d.currentConfig().configured ||
      signalAborted ||
      !parentIsIdle(ctx) ||
      parentHasPendingMessages(ctx)
    ) {
      settle("none");
      return Effect.void;
    }
    const published = sendCorrection(d.pi, recovery.review, true);
    const outcome = published.guidanceSent ? "guidance" : published.appended ? "card-only" : "none";
    if (!settle(outcome)) return Effect.void;
    if (published.appended)
      d.updateMetrics((metrics) => ({ ...metrics, cards: incrementBounded(metrics.cards) }));
    if (outcome === "guidance") {
      d.updateMetrics((metrics) => ({
        ...metrics,
        corrections: incrementBounded(metrics.corrections),
      }));
      d.ingest({
        type: "advisor_intervention",
        findingIds: recovery.findingIds,
        action: "recovery",
        requestSequence: d.getState().requestSequence,
      });
      if (!published.appended)
        d.notifyBestEffort(
          ctx,
          "Advisor recovered the agent but could not show its review card.",
          "warning",
        );
    } else
      d.notifyBestEffort(
        ctx,
        outcome === "card-only"
          ? "Advisor showed the recovery issue locally but could not restart the agent."
          : "Advisor could not deliver recovery guidance.",
        "warning",
      );
    return Effect.void;
  };

  const turnEnd = (event: TurnEndEvent, ctx: ExtensionContext): Effect.Effect<void> => {
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
      // No trajectory mutation here: clearPersistentTrajectory() above already removed
      // the active trajectory, and delivery treats a missing trajectory as abort-unsafe,
      // so a mutateTrajectory(trajectory.id, ...) call would be a guaranteed no-op.
      if (stopReason === "aborted") {
        const provenance = d.getState().pendingPersistentRecovery;
        const matchingAdvisorAbort = Boolean(
          provenance &&
          provenance.epoch === d.getState().epoch &&
          provenance.parentTurnId === d.getState().parentTurnId &&
          provenance.cancellationEpoch === d.getState().cancellationEpoch &&
          provenance.turnIndex === event.turnIndex &&
          trajectory?.id === provenance.trajectoryId,
        );
        if (!matchingAdvisorAbort) {
          d.cancelRequest();
          d.persistCurrentLedger(ctx);
        }
      }
      return Effect.void;
    }
    if (classification.phase === "final") {
      refs.lastCandidate = { candidate: classification.candidate };
    }
    if (!d.currentConfig().enabled) return Effect.void;
    if (!d.currentConfig().configured) return Effect.void;
    // Tool-calling/progress boundaries are observation-only. They must neither
    // checkpoint the Advisor nor delay the parent agent.
    if (classification.phase === "progress") return Effect.void;
    const handle = d.requestCheckpoint({
      ctx,
      focus: "standard",
      phase: "final",
      source: "automatic-final",
      requiresEnabled: true,
    });
    return handle ? d.awaitCatchUpEffectOwned(handle, ctx) : Effect.void;
  };

  return { messageEnd, agentSettled, turnEnd };
};
