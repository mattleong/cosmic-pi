import { isRecord } from "./utils.ts";
import {
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { supportsFastModel } from "pi-better-openai/fast-models";
import { requestAdvisorReview, type AdvisorUsageTelemetry } from "./client.ts";
import {
  loadAdvisorConfig,
  type AdvisorReviewPolicy,
  type ResolvedAdvisorConfig,
} from "./config.ts";
import { AdvisorFindingDedupe } from "./dedupe.ts";
import { buildAdvisorContext } from "./context.ts";
import { logAdvisorFailure } from "./failure-log.ts";
import { loadAdvisorInstructions, type LoadedAdvisorInstructions } from "./instructions.ts";
import { ADVISOR_REVIEW_MESSAGE_TYPE, registerAdvisorReviewRenderer } from "./renderer.ts";
import {
  AdvisorReviewParseError,
  buildAdvisorAdvice,
  buildProgressSteer,
  buildRevisionSteer,
  type AdvisorReview,
  type AdvisorReviewFocus,
} from "./review.ts";
import {
  type AdvisorCommandActions,
  type AdvisorSessionMetrics,
  registerAdvisorCommands,
} from "./settings.ts";
import {
  AdvisorTrajectoryDetector,
  LONG_TURN_REVIEW_MS,
  MAX_TRAJECTORY_EVIDENCE_CHARS,
  MIN_LOOP_REVIEW_MS,
} from "./trajectory.ts";

const STATUS_KEY = "pi-advisor";
const STATUS_SPINNER_INTERVAL_MS = 80;
const STATUS_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

type ReviewPhase = "final" | "progress";
type RevisionThreshold = "none" | "high" | "medium";
type ReviewSource = "automatic-final" | "automatic-progress" | "next" | "last" | "verify";

export type AdvisorSkipReason =
  | "disabled"
  | "empty"
  | "incomplete"
  | "manual-policy"
  | "pending-input"
  | "session-paused"
  | "unconfigured";

interface PendingIntervention {
  review: AdvisorReview;
  reviewJob: PendingReview;
}

type PendingRecovery = PendingIntervention;

interface PendingReview {
  abortActiveTurn: boolean;
  candidate: string;
  checkpointSequence: number;
  config: ResolvedAdvisorConfig;
  configRevision: number;
  cooldownBlocked: boolean;
  ctx: ExtensionContext;
  focus: AdvisorReviewFocus;
  generation: number;
  messages: unknown[];
  metrics: AdvisorSessionMetrics;
  phase: ReviewPhase;
  requiresEnabled: boolean;
  revisionThreshold: RevisionThreshold;
  scope: string;
  sessionEpoch: number;
  source: ReviewSource;
  turnObservationId?: number;
  workEpoch: number;
}

interface ActiveTurnObservation {
  abortAllowed: boolean;
  ctx: ExtensionContext;
  detector: AdvisorTrajectoryDetector;
  generation: number;
  id: number;
  loopChannel?: "thinking" | "text";
  loopConfirmed: boolean;
  loopReason?: string;
  reviewQueued: boolean;
  startedAt: number;
  text: string;
  thinkingChars: number;
  timer?: ReturnType<typeof setTimeout>;
  turnIndex: number;
}

interface LastCandidate {
  candidate: string;
  generation: number;
  messages: unknown[];
  sessionEpoch: number;
}

export interface AdvisorExtensionDependencies {
  loadConfig?: typeof loadAdvisorConfig;
  logFailure?: typeof logAdvisorFailure;
  requestReview?: typeof requestAdvisorReview;
}

export function createAdvisorExtension(dependencies: AdvisorExtensionDependencies = {}) {
  const loadConfig = dependencies.loadConfig ?? loadAdvisorConfig;
  const logFailure = dependencies.logFailure ?? logAdvisorFailure;
  const runReview = dependencies.requestReview ?? requestAdvisorReview;

  return function registerAdvisorExtension(pi: ExtensionAPI): void {
    let config = loadConfig();
    let configRevision = 0;
    let metrics = emptySessionMetrics();
    let setupWarningShown = false;
    let generation = 0;
    let workEpoch = 0;
    let cooldownRemaining = 0;
    let instructions: LoadedAdvisorInstructions = { paths: [] };
    const findingDedupe = new AdvisorFindingDedupe();
    const reportedFailureKinds = new Set<string>();
    let sessionEpoch = 0;
    let pendingReview: PendingReview | undefined;
    let pendingIntervention: PendingIntervention | undefined;
    let pendingRecovery: PendingRecovery | undefined;
    let activeReview: PendingReview | undefined;
    let activeController: AbortController | undefined;
    let draining = false;
    let statusContext: ExtensionContext | undefined;
    let correctionGeneration: number | undefined;
    let cooldownConsumedGeneration: number | undefined;
    let checkpointSequence = 0;
    let activeTurnObservation: ActiveTurnObservation | undefined;
    let turnObservationSequence = 0;
    let sessionPaused = false;
    let reviewNext = false;
    let lastCandidate: LastCandidate | undefined;
    let statusSpinnerContext: ExtensionContext | undefined;
    let statusSpinnerEffort: string | undefined;
    let statusSpinnerFast = false;
    let statusSpinnerFrame = 0;
    let statusSpinnerModel: string | undefined;
    let statusSpinnerTimer: ReturnType<typeof setInterval> | undefined;

    const stopStatusSpinner = (): void => {
      if (statusSpinnerTimer) clearInterval(statusSpinnerTimer);
      statusSpinnerContext = undefined;
      statusSpinnerEffort = undefined;
      statusSpinnerFast = false;
      statusSpinnerModel = undefined;
      statusSpinnerTimer = undefined;
      statusSpinnerFrame = 0;
    };

    const renderAdvisingStatus = (): void => {
      if (!statusSpinnerContext || !statusSpinnerModel || !statusSpinnerEffort) return;
      const frame = STATUS_SPINNER_FRAMES[statusSpinnerFrame] ?? STATUS_SPINNER_FRAMES[0];
      statusSpinnerContext.ui.setStatus(
        STATUS_KEY,
        `${frame} ${statusSpinnerModel}:${statusSpinnerEffort}${statusSpinnerFast ? " ⚡advising…" : " advising…"}`,
      );
    };

    const startStatusSpinner = (
      ctx: ExtensionContext,
      model: string,
      effort: string,
      fast: boolean,
    ): void => {
      if (
        statusSpinnerTimer &&
        statusSpinnerContext === ctx &&
        statusSpinnerModel === model &&
        statusSpinnerEffort === effort &&
        statusSpinnerFast === fast
      )
        return;
      stopStatusSpinner();
      statusSpinnerContext = ctx;
      statusSpinnerEffort = effort;
      statusSpinnerFast = fast;
      statusSpinnerModel = model;
      renderAdvisingStatus();
      if (ctx.mode !== "tui") return;
      statusSpinnerTimer = setInterval(() => {
        statusSpinnerFrame = (statusSpinnerFrame + 1) % STATUS_SPINNER_FRAMES.length;
        renderAdvisingStatus();
      }, STATUS_SPINNER_INTERVAL_MS);
      statusSpinnerTimer.unref();
    };

    const recordUsage = (target: AdvisorSessionMetrics, usage: AdvisorUsageTelemetry): void => {
      target.cacheReadTokens = (target.cacheReadTokens ?? 0) + usage.cacheReadTokens;
      target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + usage.cacheWriteTokens;
      target.cost = (target.cost ?? 0) + usage.cost;
      target.inputTokens = (target.inputTokens ?? 0) + usage.inputTokens;
      target.outputTokens = (target.outputTokens ?? 0) + usage.outputTokens;
      target.totalTokens = (target.totalTokens ?? 0) + usage.totalTokens;
    };

    const recordSkip = (reason: AdvisorSkipReason): void => {
      const skippedReviews = (metrics.skippedReviews ??= {});
      skippedReviews[reason] = (skippedReviews[reason] ?? 0) + 1;
    };

    const clearTurnObservation = (): void => {
      if (activeTurnObservation?.timer) clearTimeout(activeTurnObservation.timer);
      activeTurnObservation = undefined;
    };

    const clearBackgroundReviews = (
      ctx?: ExtensionContext,
      preserveCommittedRecovery = false,
    ): boolean => {
      const committedRecovery = preserveCommittedRecovery ? pendingRecovery : undefined;
      const cleared = Boolean(
        pendingReview ||
        pendingIntervention ||
        pendingRecovery ||
        activeReview ||
        activeTurnObservation,
      );
      clearTurnObservation();
      workEpoch += 1;
      pendingReview = undefined;
      pendingIntervention = undefined;
      pendingRecovery = committedRecovery;
      activeController?.abort();
      stopStatusSpinner();
      (ctx ?? statusContext)?.ui.setStatus(STATUS_KEY, undefined);
      return cleared;
    };

    const recoveryIsDeliverable = (recovery: PendingRecovery): boolean =>
      recovery.reviewJob.sessionEpoch === sessionEpoch &&
      recovery.reviewJob.generation === generation &&
      !recovery.reviewJob.ctx.hasPendingMessages();

    const reviewIsCurrent = (review: PendingReview): boolean =>
      review.sessionEpoch === sessionEpoch &&
      review.generation === generation &&
      review.checkpointSequence === checkpointSequence &&
      review.workEpoch === workEpoch &&
      review.configRevision === configRevision &&
      (!review.requiresEnabled || config.enabled) &&
      config.configured &&
      config.provider === review.config.provider &&
      config.model === review.config.model &&
      !review.ctx.hasPendingMessages();

    const refreshReviewStatus = (): void => {
      if (!statusContext) {
        stopStatusSpinner();
        return;
      }
      if (sessionPaused) {
        stopStatusSpinner();
        statusContext.ui.setStatus(STATUS_KEY, "advisor: paused");
        return;
      }
      if (pendingRecovery !== undefined && recoveryIsDeliverable(pendingRecovery)) {
        stopStatusSpinner();
        statusContext.ui.setStatus(STATUS_KEY, "advisor: recovery pending…");
        return;
      }
      if (pendingIntervention !== undefined && reviewIsCurrent(pendingIntervention.reviewJob)) {
        stopStatusSpinner();
        statusContext.ui.setStatus(STATUS_KEY, "advisor: guidance pending…");
        return;
      }
      const currentReview =
        activeReview !== undefined && reviewIsCurrent(activeReview)
          ? activeReview
          : pendingReview !== undefined && reviewIsCurrent(pendingReview)
            ? pendingReview
            : undefined;
      if (currentReview) {
        startStatusSpinner(
          statusContext,
          currentReview.config.model ?? "advisor",
          currentReview.config.thinkingLevel,
          currentReview.config.fastMode &&
            supportsFastModel(currentReview.config.provider, currentReview.config.model),
        );
        return;
      }
      stopStatusSpinner();
      statusContext.ui.setStatus(STATUS_KEY, undefined);
    };

    const deliverReview = (reviewJob: PendingReview, review: AdvisorReview): void => {
      if (!reviewIsCurrent(reviewJob)) return;
      const filtered = findingDedupe.filter(review.findings, reviewJob.scope);
      reviewJob.metrics.suppressedFindings =
        (reviewJob.metrics.suppressedFindings ?? 0) + filtered.suppressed;
      if (filtered.findings.length === 0) {
        reviewJob.metrics.lastAction = "suppressed";
        return;
      }

      if (
        reviewJob.cooldownBlocked &&
        cooldownRemaining > 0 &&
        cooldownConsumedGeneration !== reviewJob.generation
      ) {
        cooldownRemaining -= 1;
        cooldownConsumedGeneration = reviewJob.generation;
      }
      const filteredReview = { ...review, findings: filtered.findings };
      const shouldCorrect =
        correctionGeneration !== reviewJob.generation &&
        shouldRevise(reviewJob.revisionThreshold, filteredReview);
      if (shouldCorrect) {
        if (reviewJob.phase === "progress") {
          const recovering =
            reviewJob.abortActiveTurn &&
            filteredReview.findings.some((finding) => finding.severity === "high") &&
            reviewJob.turnObservationId !== undefined &&
            activeTurnObservation?.id === reviewJob.turnObservationId &&
            activeTurnObservation.abortAllowed &&
            activeTurnObservation.loopConfirmed &&
            !reviewJob.ctx.isIdle();
          correctionGeneration = reviewJob.generation;
          cooldownRemaining = reviewJob.config.revisionCooldownTurns;
          reviewJob.metrics.lastAction = recovering ? "recovery" : "guidance";
          if (recovering && reviewIsCurrent(reviewJob)) {
            pendingRecovery = { review: filteredReview, reviewJob };
            reviewJob.ctx.abort();
          } else {
            sendProgressCorrection(pi, reviewJob.config, filteredReview, false);
          }
        } else {
          sendRevisionRequest(pi, reviewJob.config, filteredReview);
          correctionGeneration = reviewJob.generation;
          cooldownRemaining = reviewJob.config.revisionCooldownTurns;
          reviewJob.metrics.lastAction = "revision";
        }
      } else {
        sendAdvisorAdvice(pi, reviewJob.config, filteredReview);
        reviewJob.metrics.lastAction = "advice";
      }
    };

    const drainReviewQueue = async (): Promise<void> => {
      if (draining) return;
      draining = true;
      try {
        while (pendingReview) {
          const reviewJob = pendingReview;
          pendingReview = undefined;
          if (!reviewIsCurrent(reviewJob)) continue;

          activeReview = reviewJob;
          const controller = new AbortController();
          activeController = controller;
          reviewJob.metrics.attempted += 1;
          const startedAt = performance.now();
          let contextChars = 0;
          refreshReviewStatus();

          try {
            const reviewContext = buildAdvisorContext({
              messages: reviewJob.messages,
              candidate: reviewJob.candidate,
              maxChars: reviewJob.config.maxContextChars,
              phase: reviewJob.phase,
            });
            contextChars = reviewContext.transcript.length;
            const review = await runReview(
              reviewJob.ctx,
              reviewJob.config,
              reviewContext.transcript,
              {
                focus: reviewJob.focus,
                instructions: instructions.content,
                onUsage: (usage) => recordUsage(reviewJob.metrics, usage),
                signal: controller.signal,
              },
            );
            if (!reviewIsCurrent(reviewJob)) {
              reviewJob.metrics.discarded += 1;
              reviewJob.metrics.lastAction = "discarded";
              continue;
            }
            if (review.verdict === "pass") {
              reviewJob.metrics.pass += 1;
              reviewJob.metrics.lastAction = "pass";
              continue;
            }

            const canCorrectProgressNow =
              reviewJob.phase === "progress" &&
              correctionGeneration !== reviewJob.generation &&
              shouldRevise(reviewJob.revisionThreshold, review) &&
              review.findings.some((finding) => finding.severity === "high");
            if (!reviewJob.ctx.isIdle() && !canCorrectProgressNow) {
              pendingIntervention = { review, reviewJob };
            } else {
              deliverReview(reviewJob, review);
            }
            reviewJob.metrics.revise += 1;
          } catch (error) {
            if (reviewIsCurrent(reviewJob)) {
              reviewJob.metrics.failure += 1;
              reviewJob.metrics.lastAction = "failure";
              const failureKind = classifyFailure(error);
              reviewJob.metrics.lastFailureKind = failureKind;
              logFailure(reviewJob.config.configPath, {
                contextChars,
                durationMs: performance.now() - startedAt,
                error,
                model: reviewJob.config.model,
                provider: reviewJob.config.provider,
                timeoutMs: reviewJob.config.timeoutMs,
              });
              if (!reportedFailureKinds.has(failureKind)) {
                reportedFailureKinds.add(failureKind);
                reviewJob.ctx.ui.notify(
                  `Advisor ${failureKind} failure; keeping the original response. See /advisor status --verbose.`,
                  "warning",
                );
              }
            } else {
              reviewJob.metrics.discarded += 1;
              reviewJob.metrics.lastAction = "discarded";
            }
          } finally {
            reviewJob.metrics.latestDurationMs = performance.now() - startedAt;
            if (activeReview === reviewJob) activeReview = undefined;
            if (activeController === controller) activeController = undefined;
            refreshReviewStatus();
          }
        }
      } finally {
        draining = false;
        refreshReviewStatus();
        if (pendingReview) void drainReviewQueue();
      }
    };

    const enqueueReview = (options: {
      abortActiveTurn?: boolean;
      candidate: string;
      ctx: ExtensionContext;
      focus?: AdvisorReviewFocus;
      messages: unknown[];
      phase: ReviewPhase;
      requiresEnabled: boolean;
      revisionThreshold: RevisionThreshold;
      source: ReviewSource;
      turnObservationId?: number;
    }): void => {
      if (pendingRecovery) return;
      checkpointSequence += 1;
      pendingIntervention = undefined;
      activeController?.abort();
      const cooldownBlocked =
        correctionGeneration !== generation &&
        (cooldownRemaining > 0 || cooldownConsumedGeneration === generation);
      pendingReview = {
        abortActiveTurn: options.abortActiveTurn ?? false,
        candidate: options.candidate,
        checkpointSequence,
        config: { ...config },
        configRevision,
        cooldownBlocked,
        ctx: options.ctx,
        focus: options.focus ?? "standard",
        generation,
        messages: options.messages,
        metrics,
        phase: options.phase,
        requiresEnabled: options.requiresEnabled,
        revisionThreshold: cooldownBlocked ? "none" : options.revisionThreshold,
        scope: `${sessionEpoch}:${generation}`,
        sessionEpoch,
        source: options.source,
        turnObservationId: options.turnObservationId,
        workEpoch,
      };
      statusContext = options.ctx;
      refreshReviewStatus();
      void drainReviewQueue();
    };

    const automaticSupervisionAvailable = (): boolean =>
      config.enabled && config.configured && config.reviewPolicy !== "manual" && !sessionPaused;

    const queueTrajectoryReview = (observation: ActiveTurnObservation, reason: string): void => {
      if (
        observation !== activeTurnObservation ||
        observation.generation !== generation ||
        observation.reviewQueued ||
        !automaticSupervisionAvailable()
      )
        return;
      observation.reviewQueued = true;
      if (observation.timer) clearTimeout(observation.timer);
      observation.timer = undefined;
      const elapsedMs = Math.max(0, performance.now() - observation.startedAt);
      const visible = observation.text.trim() || "[No visible assistant text yet.]";
      const reasoningActivity =
        observation.thinkingChars > 0
          ? `${observation.thinkingChars.toLocaleString()} reasoning characters were observed locally; their raw content is intentionally excluded from the cross-model review.`
          : "No streamed reasoning text was exposed.";
      const candidate = [
        `Checkpoint trigger: ${reason}`,
        `Elapsed active-turn time: ${Math.round(elapsedMs / 1_000)} seconds`,
        "Visible assistant output:",
        visible,
        "Reasoning stream activity:",
        reasoningActivity,
      ].join("\n\n");
      try {
        enqueueReview({
          abortActiveTurn: observation.abortAllowed && observation.loopConfirmed,
          candidate,
          ctx: observation.ctx,
          focus: "trajectory",
          messages: activeContextMessages(observation.ctx),
          phase: "progress",
          requiresEnabled: true,
          revisionThreshold: thresholdForPolicy(config.reviewPolicy),
          source: "automatic-progress",
          turnObservationId: observation.id,
        });
      } catch {
        // Streaming observation must never affect the primary response.
      }
    };

    const scheduleTrajectoryReview = (
      observation: ActiveTurnObservation,
      delayMs: number,
      reason: () => string,
    ): void => {
      if (observation.timer) clearTimeout(observation.timer);
      observation.timer = setTimeout(() => queueTrajectoryReview(observation, reason()), delayMs);
      observation.timer.unref();
    };

    const invalidateTrajectoryReview = (turnObservationId: number): void => {
      const matchesTurn = (review: PendingReview | undefined): boolean =>
        review?.turnObservationId === turnObservationId;
      if (
        !matchesTurn(pendingReview) &&
        !matchesTurn(activeReview) &&
        !matchesTurn(pendingIntervention?.reviewJob)
      )
        return;
      checkpointSequence += 1;
      if (matchesTurn(pendingReview)) pendingReview = undefined;
      if (matchesTurn(pendingIntervention?.reviewJob)) pendingIntervention = undefined;
      if (matchesTurn(activeReview)) activeController?.abort();
      refreshReviewStatus();
    };

    const commandActions: AdvisorCommandActions = {
      cancel: (ctx) => {
        statusContext = ctx;
        const hadNextReview = reviewNext;
        reviewNext = false;
        const cleared = clearBackgroundReviews(ctx, true);
        refreshReviewStatus();
        return cleared || hadNextReview;
      },
      pause: (ctx) => {
        statusContext = ctx;
        sessionPaused = true;
        reviewNext = false;
        clearBackgroundReviews(ctx, true);
        refreshReviewStatus();
      },
      resume: (ctx) => {
        statusContext = ctx;
        sessionPaused = false;
        refreshReviewStatus();
      },
      reviewLast: (ctx, focus) => {
        if (pendingRecovery || !lastCandidate || lastCandidate.sessionEpoch !== sessionEpoch)
          return false;
        clearBackgroundReviews(ctx);
        enqueueReview({
          candidate: lastCandidate.candidate,
          ctx,
          focus,
          messages: lastCandidate.messages,
          phase: "final",
          requiresEnabled: false,
          revisionThreshold: "none",
          source: focus === "verification" ? "verify" : "last",
        });
        return true;
      },
      reviewNext: (ctx) => {
        statusContext = ctx;
        reviewNext = true;
        refreshReviewStatus();
      },
      setEnabled: (ctx, _enabled) => {
        statusContext = ctx;
        sessionPaused = false;
        refreshReviewStatus();
      },
    };

    registerAdvisorReviewRenderer(pi);
    registerAdvisorCommands(
      pi,
      {
        get: () => config,
        getMetrics: () => ({
          ...metrics,
          backgroundState:
            pendingIntervention && reviewIsCurrent(pendingIntervention.reviewJob)
              ? "revision-pending"
              : activeReview && reviewIsCurrent(activeReview)
                ? "reviewing"
                : pendingReview && reviewIsCurrent(pendingReview)
                  ? "queued"
                  : "idle",
          cooldownRemaining,
          guidancePaths: instructions.paths,
          hasLastCandidate: lastCandidate !== undefined,
          paused: sessionPaused,
          queuedReviews: pendingReview && reviewIsCurrent(pendingReview) ? 1 : 0,
          reviewNext,
        }),
        update: (next) => {
          const modelChanged = config.provider !== next.provider || config.model !== next.model;
          config = next;
          configRevision += 1;
          clearBackgroundReviews(undefined, true);
          cooldownRemaining = Math.min(cooldownRemaining, next.revisionCooldownTurns);
          if (modelChanged) findingDedupe.reset();
          if (next.configured || !next.enabled) setupWarningShown = false;
          refreshReviewStatus();
        },
      },
      commandActions,
    );

    pi.on("session_start", (_event, ctx) => {
      sessionEpoch += 1;
      generation += 1;
      clearBackgroundReviews(ctx);
      config = loadConfig(config.configPath);
      configRevision += 1;
      metrics = emptySessionMetrics();
      cooldownRemaining = 0;
      findingDedupe.reset();
      reportedFailureKinds.clear();
      instructions = loadAdvisorInstructions(config.configPath, ctx.cwd, ctx.isProjectTrusted());
      setupWarningShown = false;
      statusContext = ctx;
      correctionGeneration = undefined;
      cooldownConsumedGeneration = undefined;
      sessionPaused = false;
      reviewNext = false;
      lastCandidate = undefined;
      warnIfSetupRequired(ctx, config, () => {
        setupWarningShown = true;
      });
      refreshReviewStatus();
    });

    pi.on("session_shutdown", (_event, ctx) => {
      sessionEpoch += 1;
      generation += 1;
      clearBackgroundReviews(ctx);
      statusContext = undefined;
    });

    pi.on("message_end", (event, ctx) => {
      if (!isGenuineUserMessage(event.message)) return;
      generation += 1;
      correctionGeneration = undefined;
      cooldownConsumedGeneration = undefined;
      lastCandidate = undefined;
      findingDedupe.reset();
      clearBackgroundReviews(ctx);
      refreshReviewStatus();
    });

    pi.on("turn_start", (event, ctx) => {
      clearTurnObservation();
      if (pendingRecovery || !automaticSupervisionAvailable()) return;
      const observation: ActiveTurnObservation = {
        abortAllowed: false,
        ctx,
        detector: new AdvisorTrajectoryDetector(),
        generation,
        id: ++turnObservationSequence,
        loopConfirmed: false,
        reviewQueued: false,
        startedAt: performance.now(),
        text: "",
        thinkingChars: 0,
        turnIndex: event.turnIndex,
      };
      activeTurnObservation = observation;
      scheduleTrajectoryReview(
        observation,
        LONG_TURN_REVIEW_MS,
        () => "the active turn exceeded the normal supervision interval",
      );
    });

    pi.on("message_update", (event, ctx) => {
      const observation = activeTurnObservation;
      if (!observation || observation.generation !== generation) return;
      observation.ctx = ctx;
      const update = event.assistantMessageEvent;
      if (update.type === "toolcall_start") {
        observation.abortAllowed = false;
        if (observation.timer) clearTimeout(observation.timer);
        observation.timer = undefined;
        return;
      }
      if (
        observation.loopChannel === "thinking" &&
        (update.type === "text_start" || update.type === "text_delta")
      ) {
        observation.abortAllowed = false;
      }
      if (observation.reviewQueued) return;
      if (update.type !== "thinking_delta" && update.type !== "text_delta") return;
      const channel = update.type === "thinking_delta" ? "thinking" : "text";
      const delta = update.delta;
      if (channel === "thinking") {
        observation.thinkingChars += delta.length;
      } else {
        observation.text = `${observation.text}${delta}`.slice(-MAX_TRAJECTORY_EVIDENCE_CHARS);
      }
      const signal = observation.detector.push(channel, delta);
      if (!signal) return;
      observation.abortAllowed = true;
      observation.loopChannel = signal.channel;
      observation.loopConfirmed = true;
      observation.loopReason = `${signal.channel} stream ${signal.reason}`;
      const elapsed = performance.now() - observation.startedAt;
      if (elapsed >= MIN_LOOP_REVIEW_MS) {
        queueTrajectoryReview(observation, observation.loopReason);
      } else {
        scheduleTrajectoryReview(
          observation,
          MIN_LOOP_REVIEW_MS - elapsed,
          () => observation.loopReason ?? "strong stream repetition was observed",
        );
      }
    });

    pi.on("tool_execution_start", (_event, _ctx) => {
      const observation = activeTurnObservation;
      if (!observation) return;
      observation.abortAllowed = false;
      if (observation.timer) clearTimeout(observation.timer);
      observation.timer = undefined;
    });

    pi.on("agent_settled", (_event, ctx) => {
      const recovery = pendingRecovery;
      pendingRecovery = undefined;
      if (recovery && recoveryIsDeliverable(recovery) && ctx.isIdle()) {
        try {
          sendProgressCorrection(pi, recovery.reviewJob.config, recovery.review, true);
        } catch {
          // Recovery delivery must never escape the settled-event boundary.
        }
      }

      const intervention = pendingIntervention;
      pendingIntervention = undefined;
      if (intervention && reviewIsCurrent(intervention.reviewJob) && ctx.isIdle()) {
        try {
          deliverReview(intervention.reviewJob, intervention.review);
        } catch {
          // Deferred advice must remain fail-open.
        }
      }
      refreshReviewStatus();
    });

    pi.on("turn_end", (event, ctx) => {
      const observation = activeTurnObservation;
      clearTurnObservation();
      const classification = classifyReviewCheckpoint(event);
      if (!classification.eligible) {
        if (classification.reason !== "not-assistant") recordSkip(classification.reason);
        if (
          classification.reason === "incomplete" &&
          observation &&
          pendingRecovery?.reviewJob.turnObservationId !== observation.id
        ) {
          invalidateTrajectoryReview(observation.id);
        }
        return;
      }

      const messages = activeContextMessages(ctx);
      if (classification.phase === "final") {
        lastCandidate = {
          candidate: classification.candidate,
          generation,
          messages,
          sessionEpoch,
        };
      }
      if (ctx.hasPendingMessages()) {
        recordSkip("pending-input");
        return;
      }

      const explicitlyRequested = classification.phase === "final" && reviewNext;
      if (explicitlyRequested) reviewNext = false;
      if (!explicitlyRequested) {
        if (!config.enabled) {
          recordSkip("disabled");
          return;
        }
        if (sessionPaused) {
          recordSkip("session-paused");
          return;
        }
        if (config.reviewPolicy === "manual") {
          recordSkip("manual-policy");
          return;
        }
      }
      if (!config.configured) {
        if (!setupWarningShown) {
          warnIfSetupRequired(ctx, config, () => {
            setupWarningShown = true;
          });
        }
        recordSkip("unconfigured");
        return;
      }

      enqueueReview({
        candidate: classification.candidate,
        ctx,
        focus: classification.phase === "progress" ? "trajectory" : "standard",
        messages,
        phase: classification.phase,
        requiresEnabled: !explicitlyRequested,
        revisionThreshold: thresholdForPolicy(config.reviewPolicy),
        source: explicitlyRequested
          ? "next"
          : classification.phase === "progress"
            ? "automatic-progress"
            : "automatic-final",
      });
    });
  };
}

export const advisorExtension = createAdvisorExtension();

function emptySessionMetrics(): AdvisorSessionMetrics {
  return {
    attempted: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    discarded: 0,
    failure: 0,
    inputTokens: 0,
    outputTokens: 0,
    pass: 0,
    revise: 0,
    skippedReviews: {},
    suppressedFindings: 0,
    totalTokens: 0,
  };
}

function activeContextMessages(ctx: ExtensionContext): unknown[] {
  return ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
}

function thresholdForPolicy(policy: AdvisorReviewPolicy): RevisionThreshold {
  switch (policy) {
    case "strict":
      return "medium";
    case "guardrail":
    case "manual":
      return "high";
    case "advice":
      return "none";
  }
}

function shouldRevise(threshold: RevisionThreshold, review: AdvisorReview): boolean {
  if (threshold === "none") return false;
  if (threshold === "medium") return review.findings.length > 0;
  return review.findings.some((finding) => finding.severity === "high");
}

function classifyFailure(error: unknown): string {
  if (error instanceof AdvisorReviewParseError) return "response-format";
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("auth") || message.includes("credential") || message.includes("api key")) {
    return "authentication";
  }
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (message.includes("unavailable") || message.includes("not configured")) return "model";
  if (message.includes("abort")) return "cancelled";
  return "provider";
}

function sendProgressCorrection(
  pi: ExtensionAPI,
  config: ResolvedAdvisorConfig,
  review: AdvisorReview,
  recovering: boolean,
): void {
  if (!config.provider || !config.model) return;
  pi.sendMessage(
    {
      customType: ADVISOR_REVIEW_MESSAGE_TYPE,
      content: buildProgressSteer(review, recovering),
      display: true,
      details: {
        action: recovering ? "recovery" : "guidance",
        review,
        provider: config.provider,
        model: config.model,
      },
    },
    { deliverAs: "steer", triggerTurn: true },
  );
}

function sendRevisionRequest(
  pi: ExtensionAPI,
  config: ResolvedAdvisorConfig,
  review: AdvisorReview,
): void {
  if (!config.provider || !config.model) return;
  pi.sendMessage(
    {
      customType: ADVISOR_REVIEW_MESSAGE_TYPE,
      content: buildRevisionSteer(review),
      display: true,
      details: {
        action: "revision",
        review,
        provider: config.provider,
        model: config.model,
      },
    },
    { deliverAs: "steer", triggerTurn: true },
  );
}

function sendAdvisorAdvice(
  pi: ExtensionAPI,
  config: ResolvedAdvisorConfig,
  review: AdvisorReview,
): void {
  if (!config.provider || !config.model) return;
  pi.sendMessage(
    {
      customType: ADVISOR_REVIEW_MESSAGE_TYPE,
      content: buildAdvisorAdvice(review),
      display: true,
      details: {
        action: "advice",
        review,
        provider: config.provider,
        model: config.model,
      },
    },
    { deliverAs: "steer" },
  );
}

function warnIfSetupRequired(
  ctx: ExtensionContext,
  config: ResolvedAdvisorConfig,
  markShown: () => void,
): void {
  if (!config.enabled || config.configured) return;
  markShown();
  ctx.ui.notify(
    "Advisor review is enabled but no dedicated model is configured. Use /advisor-settings.",
    "warning",
  );
}

function isGenuineUserMessage(message: unknown): boolean {
  return isRecord(message) && message.role === "user";
}

type CandidateClassification =
  | { eligible: true; candidate: string; phase: ReviewPhase }
  | {
      eligible: false;
      reason: "not-assistant" | "empty" | "incomplete";
    };

function classifyReviewCheckpoint(event: TurnEndEvent): CandidateClassification {
  const message = event.message;
  if (!isRecord(message) || message.role !== "assistant") {
    return { eligible: false, reason: "not-assistant" };
  }
  if (
    message.stopReason === "aborted" ||
    message.stopReason === "error" ||
    message.stopReason === "length"
  )
    return { eligible: false, reason: "incomplete" };
  if (!Array.isArray(message.content)) return { eligible: false, reason: "empty" };
  const hasToolCall = message.content.some((part) => isRecord(part) && part.type === "toolCall");
  if (hasToolCall) {
    const candidate = assistantCheckpointText(message);
    return candidate
      ? { eligible: true, candidate, phase: "progress" }
      : { eligible: false, reason: "empty" };
  }
  if (message.stopReason !== "stop") return { eligible: false, reason: "incomplete" };
  const candidate = assistantText(message);
  return candidate
    ? { eligible: true, candidate, phase: "final" }
    : { eligible: false, reason: "empty" };
}

function classifyReviewCandidate(event: TurnEndEvent): CandidateClassification {
  const result = classifyReviewCheckpoint(event);
  return result.eligible && result.phase !== "final"
    ? { eligible: false, reason: "incomplete" }
    : result;
}

function isReviewCandidate(event: TurnEndEvent): boolean {
  return classifyReviewCandidate(event).eligible;
}

function assistantCheckpointText(message: unknown): string | undefined {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
    return undefined;
  }
  const parts = message.content.flatMap((part) => {
    if (!isRecord(part)) return [];
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      return [part.text.trim()];
    }
    if (part.type !== "toolCall") return [];
    const name = typeof part.name === "string" && part.name ? part.name : "unknown";
    let args = "";
    try {
      args = part.arguments === undefined ? "" : ` ${JSON.stringify(part.arguments)}`;
    } catch {
      args = " [unserializable arguments]";
    }
    return [`[tool call: ${name}${args}]`];
  });
  const text = parts.join("\n").trim();
  return text || undefined;
}

function assistantText(message: unknown): string | undefined {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
    return undefined;
  }
  const text = message.content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n")
    .trim();
  return text || undefined;
}

export const _extensionTest = {
  activeContextMessages,
  assistantCheckpointText,
  assistantText,
  classifyFailure,
  classifyReviewCandidate,
  classifyReviewCheckpoint,
  isGenuineUserMessage,
  isReviewCandidate,
  shouldRevise,
  thresholdForPolicy,
};
