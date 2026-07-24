/** Host event registration and session initialize/shutdown/compact/tree. */
import * as Effect from "effect/Effect";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { advisorDelay } from "../../boundary/clock.ts";
import type { AdvisorEffectExecutor, AdvisorPlatform } from "../../boundary/executor.ts";
import type { AdvisorHostBindings } from "../../boundary/host-bindings.ts";
import { PiCommandAdapter } from "../../boundary/host-commands.ts";
import {
  captureAdvisorAbortInputAtHostBoundary,
  captureAdvisorSessionInputEffect,
  registerAdvisorAbortListenerEffect,
  type AdvisorSessionInput,
} from "../../boundary/host-context.ts";
import { summarizeAdvisorReview } from "../../checkpoint/ledger.ts";
import type { CheckpointOrchestratorShape } from "../../checkpoint/orchestrator.ts";
import { getAdvisorConfigPath, type ResolvedAdvisorConfig } from "../../config/options.ts";
import type { ConfigStoreShape } from "../../config/store.ts";
import {
  assistantStopReason,
  assistantToolCalls,
  classifyReviewCheckpoint,
  contentText,
  isGenuineUserMessage,
  safeObservationJson,
} from "../../domain/candidate.ts";
import { acknowledgeAdvisorFindings } from "../../review/finding-lifecycle.ts";
import { loadAdvisorInstructionsEffect } from "../../review/instructions.ts";
import {
  armAdvisorInterruption,
  clearAdvisorCancellation,
  completeAdvisorPrimaryTurn,
  emptyAdvisorRoutingState,
} from "../../review/routing.ts";
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
} from "../../review/trajectory.ts";
import {
  reviewWithAcknowledgedFindings,
  sendTriggeredCorrection,
  warnIfSetupRequired,
} from "../controller-helpers.ts";
import {
  AdvisorExtensionError,
  extensionError,
  type AdvisorCheckpointHandle,
  type AdvisorSkipReason,
  type ParentAnchor,
} from "../controller-types.ts";
import {
  initialAdvisorApplicationState,
  type AdvisorActiveTrajectoryState,
  type AdvisorApplicationState,
} from "../state.ts";
import { parentHasPendingMessages, parentIsIdle, parentSignalAborted } from "./parent-session.ts";
import type { SessionRefs } from "./session-refs.ts";

export interface EventsDeps {
  readonly refs: SessionRefs;
  readonly pi: ExtensionAPI;
  readonly hostBindings: AdvisorHostBindings;
  readonly getState: () => AdvisorApplicationState;
  readonly updateApplicationState: (
    update: (state: AdvisorApplicationState) => AdvisorApplicationState,
  ) => void;
  readonly mutateMetrics: (mutate: (next: AdvisorApplicationState["metrics"]) => void) => void;
  readonly currentConfig: () => ResolvedAdvisorConfig;
  readonly isPaused: () => boolean;
  readonly isStarted: () => boolean;
  readonly advanceDomainCounter: (
    key: "epoch" | "cancellationEpoch" | "parentTurnId" | "requestSequence",
  ) => number;
  readonly setDomainCounter: (
    key: "epoch" | "cancellationEpoch" | "parentTurnId" | "requestSequence",
    value: number,
  ) => number;
  readonly clearPersistentTrajectory: () => void;
  readonly clearPendingRecovery: () => void;
  readonly clearPendingReceipt: () => void;
  readonly latchCancellation: () => void;
  readonly resetRequestDomain: (resetLifecycle?: boolean) => void;
  readonly persistCurrentLedger: (ctx: ExtensionContext) => void;
  readonly persistLedger: (anchor: ParentAnchor) => void;
  readonly ingest: (
    input: Parameters<import("../../queue/service.ts").AdvisorReviewQueue["ingest"]>[1],
  ) => void;
  readonly recordReceipt: (ids: readonly string[]) => void;
  readonly recordSkip: (reason: AdvisorSkipReason) => void;
  readonly mutateTrajectory: (
    id: number,
    mutate: (next: AdvisorActiveTrajectoryState) => AdvisorActiveTrajectoryState,
  ) => AdvisorActiveTrajectoryState | undefined;
  readonly runSessionEffect: <A, E>(
    effect: Effect.Effect<A, E, AdvisorPlatform | PiCommandAdapter>,
  ) => Promise<A>;
  readonly parentExecutor: AdvisorEffectExecutor;
  readonly notifyBestEffort: (
    ctx: Pick<ExtensionContext, "ui">,
    message: string,
    level: "info" | "warning" | "error",
  ) => void;
  readonly startRuntimeEffect: (
    ctx: ExtensionContext,
    restoration?: "preserve-live" | "restore-branch",
    allowDisabled?: boolean,
  ) => Effect.Effect<number | undefined>;
  readonly stopRuntimeEffect: () => Effect.Effect<void>;
  readonly stopRuntimeUnlockedEffect: () => Effect.Effect<void>;
  readonly runWithExplicitRuntimeEffect: <T>(
    ctx: ExtensionContext,
    action: () => T,
  ) => Effect.Effect<T | undefined>;
  readonly requestCheckpoint: (options: {
    ctx: ExtensionContext;
    focus: import("../../review/index.ts").AdvisorReviewFocus;
    phase: import("../controller-types.ts").ReviewPhase;
    source: import("../controller-types.ts").ReviewSource;
    requiresEnabled: boolean;
    trajectoryId?: number;
    abortOnBlocker?: boolean;
  }) => AdvisorCheckpointHandle | undefined;
  readonly awaitCatchUpEffectOwned: (
    handle: AdvisorCheckpointHandle,
    ctx: ExtensionContext,
  ) => Effect.Effect<void>;
  readonly awaitCatchUp: (handle: AdvisorCheckpointHandle, ctx: ExtensionContext) => Promise<void>;
  readonly fingerprint: () => string;
  readonly parentAnchor: (ctx: ExtensionContext) => ParentAnchor;
  readonly publishControllerSnapshot: () => Effect.Effect<void>;
  readonly checkpointOrchestrator: CheckpointOrchestratorShape;
  readonly configStore: ConfigStoreShape;
}

export const registerLifecycleEvents = (d: EventsDeps) => {
  const refs = d.refs;
  const sessionInitializeEffect = (input: AdvisorSessionInput) =>
    Effect.gen(function* () {
      const ctx = input.ctx;
      d.advanceDomainCounter("epoch");
      d.advanceDomainCounter("cancellationEpoch");
      refs.pendingExplicitStart = undefined;
      yield* d.checkpointOrchestrator.cancelAll();
      refs.removeHostCancellation?.();
      refs.removeHostCancellation = undefined;
      refs.activeContext = undefined;
      refs.activeSessionInput = undefined;
      yield* d.stopRuntimeUnlockedEffect();
      let hostCancellationPending = false;
      let hostCancellationActive = false;
      const applyHostCancellation = () => {
        d.latchCancellation();
        d.clearPendingRecovery();
        d.clearPendingReceipt();
        d.advanceDomainCounter("cancellationEpoch");
        d.persistCurrentLedger(ctx);
      };
      const latchHostCancellation = () => {
        hostCancellationPending = true;
        if (hostCancellationActive) applyHostCancellation();
      };
      const registration = yield* registerAdvisorAbortListenerEffect(
        input,
        latchHostCancellation,
      ).pipe(Effect.mapError(extensionError("host cancellation registration")));
      let registrationCommitted = false;
      const initialize = Effect.gen(function* () {
        refs.activeContext = ctx;
        refs.activeSessionInput = input;
        const configPath = d.currentConfig().configPath || getAdvisorConfigPath();
        const configEffect = d.configStore
          .load(configPath)
          .pipe(Effect.mapError(extensionError("config load")));
        const loadedConfig = yield* configEffect;
        refs.configRevision += 1;
        d.updateApplicationState(() => initialAdvisorApplicationState(loadedConfig));
        refs.childStartedOnce = false;
        refs.instructions = yield* loadAdvisorInstructionsEffect(
          d.currentConfig().configPath,
          input.cwd,
          input.projectTrusted,
        ).pipe(Effect.mapError(extensionError("instruction load")));
        d.updateApplicationState((state) => ({
          ...state,
          paused: false,
          reviewNext: false,
          guidancePaths: [...refs.instructions.paths],
          hasLastCandidate: false,
        }));
        refs.pendingExplicitStart = undefined;
        refs.lastCandidate = undefined;
        d.setDomainCounter("parentTurnId", 0);
        refs.checkpointId = 0;
        d.advanceDomainCounter("cancellationEpoch");
        d.resetRequestDomain(true);
        d.setDomainCounter("requestSequence", 0);
        d.updateApplicationState((state) => ({
          ...state,
          routing: emptyAdvisorRoutingState(),
        }));
        refs.latestStateSummary = "";
        refs.latestDurableSummary = summarizeAdvisorReview();
        d.updateApplicationState((state) => ({
          ...state,
          reportedFailures: [],
          reportedDiagnostics: [],
        }));
        yield* d.publishControllerSnapshot();
        if (!d.currentConfig().configured)
          warnIfSetupRequired(ctx, d.currentConfig(), () => undefined, d.notifyBestEffort);
        if (hostCancellationPending)
          return yield* new AdvisorExtensionError({
            operation: "session initialization",
            message: "Advisor session initialization was cancelled.",
          });
        hostCancellationActive = true;
        yield* d.startRuntimeEffect(ctx, "restore-branch");
        refs.removeHostCancellation = registration.remove;
        registrationCommitted = true;
      });
      yield* initialize.pipe(
        Effect.onExit(() =>
          registrationCommitted
            ? Effect.void
            : Effect.sync(() => {
                registration.remove();
                if (refs.activeContext === ctx) refs.activeContext = undefined;
                if (refs.activeSessionInput === input) refs.activeSessionInput = undefined;
              }),
        ),
      );
    });
  const sessionShutdownEffect = () =>
    Effect.sync(() => {
      d.advanceDomainCounter("epoch");
      refs.pendingExplicitStart = undefined;
      refs.activeContext = undefined;
      refs.activeSessionInput = undefined;
      refs.removeHostCancellation?.();
      refs.removeHostCancellation = undefined;
    }).pipe(
      Effect.andThen(d.checkpointOrchestrator.cancelAll()),
      Effect.andThen(d.stopRuntimeEffect()),
    );
  const compactEffect = (ctx: ExtensionContext) =>
    Effect.sync(() => {
      d.ingest({ type: "compaction", marker: "Parent context was compacted." });
      refs.pendingExplicitStart = undefined;
    }).pipe(Effect.andThen(d.startRuntimeEffect(ctx)), Effect.asVoid);
  const treeEffect = (ctx: ExtensionContext) =>
    Effect.sync(() => {
      d.ingest({ type: "tree", marker: "Parent active branch changed." });
      refs.pendingExplicitStart = undefined;
      refs.lastCandidate = undefined;
      d.updateApplicationState((state) => ({ ...state, hasLastCandidate: false }));
      d.resetRequestDomain(true);
    }).pipe(Effect.andThen(d.startRuntimeEffect(ctx, "restore-branch")), Effect.asVoid);

  d.hostBindings.registerEvent("session_start", (_event, ctx) =>
    d.runSessionEffect(
      captureAdvisorSessionInputEffect(ctx).pipe(
        Effect.mapError(extensionError("session input capture")),
        Effect.flatMap(sessionInitializeEffect),
      ),
    ),
  );
  d.hostBindings.registerEvent("session_shutdown", () =>
    d.runSessionEffect(sessionShutdownEffect()),
  );
  d.hostBindings.registerEvent("session_compact", (_event, ctx) =>
    d.runSessionEffect(compactEffect(ctx)),
  );
  d.hostBindings.registerEvent("session_tree", (_event, ctx) =>
    d.runSessionEffect(treeEffect(ctx)),
  );

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
    if (!d.currentConfig().enabled || d.isPaused() || !d.currentConfig().configured) return;
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
    d.mutateTrajectory(observation.id, (current) => ({ ...current, reviewQueued: true }));
    const currentResource = refs.activeTrajectoryResource;
    if (!currentResource || currentResource.id !== observation.id) return;
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

  return {
    sessionInitializeEffect,
    sessionShutdownEffect,
    compactEffect,
    treeEffect,
  };
};
