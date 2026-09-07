import type {
  ExtensionContext,
  MessageUpdateEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { safeObservationJson } from "../../../domain/candidate.ts";
import {
  advisorActiveToolCount,
  emptyAdvisorToolTrajectoryDetector,
  emptyAdvisorTrajectoryDetector,
  endAdvisorToolTrajectory,
  isMateriallyNovelAdvisorTerminal,
  LONG_TURN_REVIEW_MS,
  markConcreteAdvisorProgress,
  pushAdvisorTrajectory,
  startAdvisorToolTrajectory,
} from "../../../review/trajectory.ts";
import type { AdvisorActiveTrajectoryState } from "../../state.ts";
import type { EventsDeps } from "./types.ts";

export const makeTrajectoryEventHandlers = (d: EventsDeps) => {
  const refs = d.refs;

  const turnStart = (event: TurnStartEvent, ctx: ExtensionContext): Effect.Effect<void> => {
    d.clearPersistentTrajectory();
    d.clearPendingRecovery();
    const receipt = d.getState().pendingReceipt;
    if (
      receipt &&
      receipt.cancellationEpoch === d.getState().cancellationEpoch &&
      receipt.requestSequence === d.getState().requestSequence
    ) {
      d.ingest({
        type: "advisor_intervention_receipt",
        findingIds: receipt.ids,
        requestSequence: d.getState().requestSequence,
      });
    }
    d.clearPendingReceipt();
    d.advanceDomainCounter("parentTurnId");
    if (!d.currentConfig().enabled || !d.currentConfig().configured) return Effect.void;
    const observation: AdvisorActiveTrajectoryState = {
      abortAllowed: false,
      detector: emptyAdvisorTrajectoryDetector(),
      toolDetector: emptyAdvisorToolTrajectoryDetector(),
      generation: d.getState().parentTurnId,
      id: ++refs.trajectorySequence,
      loopConfirmed: false,
      reviewQueued: false,
      turnIndex: event.turnIndex,
    };
    d.updateApplicationState((state) => ({ ...state, activeTrajectory: observation }));
    refs.activeTrajectoryResource = { id: observation.id, ctx };
    refs.activeTrajectoryResource.cancelTimer = d.scheduleDelay(LONG_TURN_REVIEW_MS, () => {
      const current = d.getState().activeTrajectory;
      if (!current || current.id !== observation.id || current.reviewQueued) return;
      d.mutateTrajectory(observation.id, (next) => ({ ...next, reviewQueued: true }));
      d.requestCheckpoint({
        ctx,
        focus: "trajectory",
        phase: "progress",
        source: "automatic-progress",
        requiresEnabled: true,
        trajectoryId: observation.id,
        abortOnBlocker: false,
      });
    });
    return Effect.void;
  };

  const messageUpdate = (event: MessageUpdateEvent): Effect.Effect<void> => {
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta") {
      d.ingest({ type: "assistant_text_delta", text: update.delta });
    } else if (update.type === "thinking_delta") {
      d.ingest({ type: "assistant_thinking_delta", text: update.delta });
    }
    const observation = d.getState().activeTrajectory;
    if (!observation || observation.reviewQueued) return Effect.void;
    if (update.type !== "text_delta" && update.type !== "thinking_delta") return Effect.void;
    const channel = update.type === "thinking_delta" ? "thinking" : "text";
    const trajectoryResult = pushAdvisorTrajectory(observation.detector, channel, update.delta);
    const signal = trajectoryResult.signal;
    const next = d.mutateTrajectory(observation.id, (current) => {
      const base = {
        ...current,
        detector: trajectoryResult.state,
        abortAllowed:
          signal !== undefined
            ? advisorActiveToolCount(current.toolDetector) === 0
            : current.loopChannel === "thinking" && channel === "text"
              ? false
              : current.abortAllowed,
      };
      return signal
        ? {
            ...base,
            loopChannel: signal.channel,
            loopConfirmed: true,
          }
        : base;
    });
    if (!signal || !next) return Effect.void;
    const currentResource = refs.activeTrajectoryResource;
    if (!currentResource || currentResource.id !== observation.id || next.reviewQueued)
      return Effect.void;
    d.mutateTrajectory(observation.id, (current) => ({ ...current, reviewQueued: true }));
    currentResource.cancelTimer?.();
    delete currentResource.cancelTimer;
    d.requestCheckpoint({
      ctx: currentResource.ctx,
      focus: "trajectory",
      phase: "progress",
      source: "automatic-progress",
      requiresEnabled: true,
      trajectoryId: observation.id,
      abortOnBlocker: next.abortAllowed,
    });
    return Effect.void;
  };

  const toolExecutionStart = (event: ToolExecutionStartEvent): Effect.Effect<void> => {
    refs.activeToolCalls.set(event.toolCallId, { args: event.args });
    const trajectory = d.getState().activeTrajectory;
    if (trajectory) {
      d.mutateTrajectory(trajectory.id, (current) => ({
        ...current,
        abortAllowed: false,
        toolDetector: startAdvisorToolTrajectory(current.toolDetector, event.toolCallId),
      }));
      if (refs.activeTrajectoryResource?.id === trajectory.id) {
        refs.activeTrajectoryResource.cancelTimer?.();
        delete refs.activeTrajectoryResource.cancelTimer;
      }
    }
    d.ingest({
      type: "tool_start",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: safeObservationJson(event.args),
    });
    return Effect.void;
  };

  const toolExecutionUpdate = (event: ToolExecutionUpdateEvent): Effect.Effect<void> => {
    d.ingest({
      type: "tool_update",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      update: safeObservationJson(event.partialResult),
    });
    return Effect.void;
  };

  const toolExecutionEnd = (event: ToolExecutionEndEvent): Effect.Effect<void> => {
    const call = refs.activeToolCalls.get(event.toolCallId);
    refs.activeToolCalls.delete(event.toolCallId);
    d.ingest({
      type: "tool_end",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: safeObservationJson(event.result),
      isError: event.isError,
    });
    const observation = d.getState().activeTrajectory;
    if (!observation) return Effect.void;
    const terminal = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: call?.args ?? "[call arguments unavailable]",
      result: event.result,
      isError: event.isError,
    };
    const concreteProgress = isMateriallyNovelAdvisorTerminal(
      observation.toolDetector,
      terminal,
      observation.loopConfirmed,
    );
    const toolResult = endAdvisorToolTrajectory(observation.toolDetector, terminal);
    const signal = toolResult.signal;
    const next = d.mutateTrajectory(observation.id, (current) => ({
      ...current,
      toolDetector: concreteProgress
        ? markConcreteAdvisorProgress(toolResult.state)
        : toolResult.state,
      loopConfirmed: concreteProgress ? false : signal ? true : current.loopConfirmed,
      abortAllowed: concreteProgress
        ? false
        : signal
          ? signal.abortSafe
          : advisorActiveToolCount(toolResult.state) === 0,
    }));
    if (concreteProgress || !signal || !next || next.reviewQueued) return Effect.void;
    d.ingest({
      type: "trajectory_signal",
      kind: signal.kind,
      confidence: signal.confidence,
      reason: signal.reason,
      evidence: signal.evidence,
      abortSafe: signal.abortSafe,
    });
    const currentResource = refs.activeTrajectoryResource;
    if (!currentResource || currentResource.id !== observation.id) return Effect.void;
    d.mutateTrajectory(observation.id, (current) => ({ ...current, reviewQueued: true }));
    d.requestCheckpoint({
      ctx: currentResource.ctx,
      focus: "trajectory",
      phase: "progress",
      source: "automatic-progress",
      requiresEnabled: true,
      trajectoryId: observation.id,
      abortOnBlocker: true,
    });
    return Effect.void;
  };

  return {
    turnStart,
    messageUpdate,
    toolExecutionStart,
    toolExecutionUpdate,
    toolExecutionEnd,
  };
};
