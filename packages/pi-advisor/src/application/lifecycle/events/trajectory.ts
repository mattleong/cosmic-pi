import { advisorDelay } from "../../../boundary/clock.ts";
import { safeObservationJson } from "../../../domain/candidate.ts";
import {
  advisorActiveToolCount,
  emptyAdvisorToolTrajectoryDetector,
  emptyAdvisorTrajectoryDetector,
  endAdvisorToolTrajectory,
  isMateriallyNovelAdvisorTerminal,
  LONG_TURN_REVIEW_MS,
  markConcreteAdvisorProgress,
  MAX_TRAJECTORY_EVIDENCE_CHARS,
  pushAdvisorTrajectory,
  startAdvisorToolTrajectory,
} from "../../../review/trajectory.ts";
import type { AdvisorActiveTrajectoryState } from "../../state.ts";
import type { EventsDeps } from "./types.ts";

export const registerTrajectoryEvents = (d: EventsDeps): void => {
  const refs = d.refs;
  d.hostBindings.registerEvent("turn_start", (event, ctx) => {
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
      d.mutateMetrics((next) => {
        next.interventionsAcknowledged = (next.interventionsAcknowledged ?? 0) + receipt.count;
      });
    }
    d.clearPendingReceipt();
    d.advanceDomainCounter("parentTurnId");
    if (!d.currentConfig().enabled || !d.currentConfig().configured) return;
    const observation: AdvisorActiveTrajectoryState = {
      abortAllowed: false,
      detector: emptyAdvisorTrajectoryDetector(),
      toolDetector: emptyAdvisorToolTrajectoryDetector(),
      generation: d.getState().parentTurnId,
      id: ++refs.trajectorySequence,
      loopConfirmed: false,
      reviewQueued: false,
      text: "",
      thinkingChars: 0,
      turnIndex: event.turnIndex,
    };
    d.updateApplicationState((state) => ({ ...state, activeTrajectory: observation }));
    refs.activeTrajectoryResource = { id: observation.id, ctx };
    refs.activeTrajectoryResource.cancelTimer = advisorDelay(
      d.parentExecutor,
      LONG_TURN_REVIEW_MS,
      () => {
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
      },
    );
  });

  d.hostBindings.registerEvent("message_update", (event, _ctx) => {
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta") {
      d.ingest({ type: "assistant_text_delta", text: update.delta });
    } else if (update.type === "thinking_delta") {
      d.ingest({ type: "assistant_thinking_delta", text: update.delta });
    }
    const observation = d.getState().activeTrajectory;
    if (!observation || observation.reviewQueued) return;
    if (update.type !== "text_delta" && update.type !== "thinking_delta") return;
    const channel = update.type === "thinking_delta" ? "thinking" : "text";
    const trajectoryResult = pushAdvisorTrajectory(observation.detector, channel, update.delta);
    const signal = trajectoryResult.signal;
    const next = d.mutateTrajectory(observation.id, (current) => ({
      ...current,
      detector: trajectoryResult.state,
      thinkingChars:
        channel === "thinking"
          ? current.thinkingChars + update.delta.length
          : current.thinkingChars,
      text:
        channel === "text"
          ? `${current.text}${update.delta}`.slice(-MAX_TRAJECTORY_EVIDENCE_CHARS)
          : current.text,
      abortAllowed:
        signal !== undefined
          ? advisorActiveToolCount(current.toolDetector) === 0
          : current.loopChannel === "thinking" && channel === "text"
            ? false
            : current.abortAllowed,
      ...(signal
        ? {
            loopChannel: signal.channel,
            loopConfirmed: true,
            loopReason: `${signal.channel} stream ${signal.reason}`,
          }
        : {}),
    }));
    if (!signal || !next) return;
    const currentResource = refs.activeTrajectoryResource;
    if (!currentResource || currentResource.id !== observation.id || next.reviewQueued) return;
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
  });

  d.hostBindings.registerEvent("tool_execution_start", (event, _ctx) => {
    refs.activeToolCalls.set(event.toolCallId, { toolName: event.toolName, args: event.args });
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
  });

  d.hostBindings.registerEvent("tool_execution_update", (event, _ctx) => {
    d.ingest({
      type: "tool_update",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      update: safeObservationJson(event.partialResult),
    });
  });

  d.hostBindings.registerEvent("tool_execution_end", (event, _ctx) => {
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
    if (!observation) return;
    const terminal = {
      parentTurnId: d.getState().parentTurnId,
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
    const next = d.mutateTrajectory(observation.id, (current) => {
      const { loopReason: _loopReason, ...withoutLoopReason } = current;
      return {
        ...(concreteProgress ? withoutLoopReason : current),
        toolDetector: concreteProgress
          ? markConcreteAdvisorProgress(toolResult.state)
          : toolResult.state,
        loopConfirmed: concreteProgress ? false : signal ? true : current.loopConfirmed,
        ...(signal && !concreteProgress ? { loopReason: signal.reason } : {}),
        abortAllowed: concreteProgress
          ? false
          : signal
            ? signal.abortSafe
            : advisorActiveToolCount(toolResult.state) === 0,
      };
    });
    if (concreteProgress || !signal || !next || next.reviewQueued) return;
    d.ingest({
      type: "trajectory_signal",
      kind: signal.kind,
      confidence: signal.confidence,
      reason: signal.reason,
      evidence: signal.evidence,
      abortSafe: signal.abortSafe,
    });
    const currentResource = refs.activeTrajectoryResource;
    if (!currentResource || currentResource.id !== observation.id) return;
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
  });
};
