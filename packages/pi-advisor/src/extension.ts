import { isRecord } from "./utils.ts";
import {
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { requestAdvisorReview, type AdvisorUsageTelemetry } from "./client.ts";
import { loadAdvisorConfig, type ResolvedAdvisorConfig } from "./config.ts";
import { AdvisorFindingDedupe } from "./dedupe.ts";
import { buildAdvisorContext } from "./context.ts";
import { logAdvisorFailure } from "./failure-log.ts";
import { loadAdvisorInstructions, type LoadedAdvisorInstructions } from "./instructions.ts";
import { ADVISOR_REVIEW_MESSAGE_TYPE, registerAdvisorReviewRenderer } from "./renderer.ts";
import { buildAdvisorAdvice, buildRevisionSteer, type AdvisorReview } from "./review.ts";
import { type AdvisorSessionMetrics, registerAdvisorCommands } from "./settings.ts";

const STATUS_KEY = "pi-advisor";

type ReviewCycleState = "eligible" | "reviewed";

interface PendingIntervention {
  review: AdvisorReview;
  reviewJob: PendingReview;
}

interface PendingReview {
  allowRevision: boolean;
  candidate: string;
  config: ResolvedAdvisorConfig;
  configRevision: number;
  ctx: ExtensionContext;
  generation: number;
  messages: unknown[];
  metrics: AdvisorSessionMetrics;
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
    let cycle: ReviewCycleState = "eligible";
    let metrics = emptySessionMetrics();
    let setupWarningShown = false;
    let generation = 0;
    let cooldownRemaining = 0;
    let instructions: LoadedAdvisorInstructions = { paths: [] };
    const findingDedupe = new AdvisorFindingDedupe();
    let sessionEpoch = 0;
    let pendingReview: PendingReview | undefined;
    let pendingIntervention: PendingIntervention | undefined;
    let activeReview: PendingReview | undefined;
    let activeController: AbortController | undefined;
    let draining = false;
    let statusContext: ExtensionContext | undefined;
    let suppressNextCandidate = false;

    const recordUsage = (target: AdvisorSessionMetrics, usage: AdvisorUsageTelemetry): void => {
      target.cacheReadTokens = (target.cacheReadTokens ?? 0) + usage.cacheReadTokens;
      target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + usage.cacheWriteTokens;
      target.cost = (target.cost ?? 0) + usage.cost;
      target.inputTokens = (target.inputTokens ?? 0) + usage.inputTokens;
      target.outputTokens = (target.outputTokens ?? 0) + usage.outputTokens;
      target.totalTokens = (target.totalTokens ?? 0) + usage.totalTokens;
    };

    const clearBackgroundReviews = (ctx?: ExtensionContext): void => {
      pendingReview = undefined;
      pendingIntervention = undefined;
      activeController?.abort();
      (ctx ?? statusContext)?.ui.setStatus(STATUS_KEY, undefined);
    };

    const reviewIsCurrent = (review: PendingReview): boolean =>
      review.sessionEpoch === sessionEpoch &&
      review.generation === generation &&
      review.configRevision === configRevision &&
      config.enabled &&
      config.configured &&
      config.provider === review.config.provider &&
      config.model === review.config.model &&
      !review.ctx.hasPendingMessages();

    const refreshReviewStatus = (): void => {
      const hasCurrentReview =
        (activeReview !== undefined && reviewIsCurrent(activeReview)) ||
        (pendingReview !== undefined && reviewIsCurrent(pendingReview));
      statusContext?.ui.setStatus(STATUS_KEY, hasCurrentReview ? "advisor: reviewing…" : undefined);
    };

    const deliverReview = (reviewJob: PendingReview, review: AdvisorReview): void => {
      const filtered = findingDedupe.filter(review.findings);
      reviewJob.metrics.suppressedFindings =
        (reviewJob.metrics.suppressedFindings ?? 0) + filtered.suppressed;
      if (filtered.findings.length === 0) {
        reviewJob.metrics.lastAction = "suppressed";
        return;
      }

      const filteredReview = { ...review, findings: filtered.findings };
      if (reviewJob.allowRevision) {
        sendRevisionRequest(pi, reviewJob.config, filteredReview);
        cooldownRemaining = reviewJob.config.revisionCooldownTurns;
        reviewJob.metrics.lastAction = "revision";
        suppressNextCandidate = true;
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
            });
            contextChars = reviewContext.transcript.length;
            const review = await runReview(
              reviewJob.ctx,
              reviewJob.config,
              reviewContext.transcript,
              {
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

            if (!reviewJob.ctx.isIdle()) {
              pendingIntervention = { review, reviewJob };
            } else {
              deliverReview(reviewJob, review);
            }
            reviewJob.metrics.revise += 1;
          } catch (error) {
            if (reviewIsCurrent(reviewJob)) {
              reviewJob.metrics.failure += 1;
              reviewJob.metrics.lastAction = "failure";
              logFailure(reviewJob.config.configPath, {
                contextChars,
                durationMs: performance.now() - startedAt,
                error,
                model: reviewJob.config.model,
                provider: reviewJob.config.provider,
                timeoutMs: reviewJob.config.timeoutMs,
              });
              reviewJob.ctx.ui.notify(
                "Advisor review failed; keeping the original response.",
                "warning",
              );
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

    registerAdvisorReviewRenderer(pi);
    registerAdvisorCommands(pi, {
      get: () => config,
      getMetrics: () => ({
        ...metrics,
        backgroundState:
          activeReview && reviewIsCurrent(activeReview)
            ? "reviewing"
            : pendingReview && reviewIsCurrent(pendingReview)
              ? "queued"
              : "idle",
        cooldownRemaining,
        guidancePaths: instructions.paths,
        queuedReviews: pendingReview && reviewIsCurrent(pendingReview) ? 1 : 0,
      }),
      update: (next) => {
        const modelChanged = config.provider !== next.provider || config.model !== next.model;
        config = next;
        configRevision += 1;
        clearBackgroundReviews();
        cooldownRemaining = Math.min(cooldownRemaining, next.revisionCooldownTurns);
        if (modelChanged) findingDedupe.reset();
        if (next.configured || !next.enabled) setupWarningShown = false;
      },
    });

    pi.on("session_start", (_event, ctx) => {
      sessionEpoch += 1;
      generation += 1;
      clearBackgroundReviews(ctx);
      config = loadConfig(config.configPath);
      configRevision += 1;
      cycle = "eligible";
      metrics = emptySessionMetrics();
      cooldownRemaining = 0;
      findingDedupe.reset();
      instructions = loadAdvisorInstructions(config.configPath, ctx.cwd, ctx.isProjectTrusted());
      setupWarningShown = false;
      statusContext = ctx;
      suppressNextCandidate = false;
      warnIfSetupRequired(ctx, config, () => {
        setupWarningShown = true;
      });
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
      cycle = "eligible";
      clearBackgroundReviews(ctx);
    });

    pi.on("agent_settled", (_event, ctx) => {
      const intervention = pendingIntervention;
      pendingIntervention = undefined;
      if (!intervention || !reviewIsCurrent(intervention.reviewJob) || !ctx.isIdle()) return;
      deliverReview(intervention.reviewJob, intervention.review);
    });

    pi.on("turn_end", (event, ctx) => {
      if (suppressNextCandidate && isReviewCandidate(event)) {
        suppressNextCandidate = false;
        cycle = "reviewed";
        return;
      }
      if (cycle !== "eligible" || !config.enabled || !isReviewCandidate(event)) return;
      if (ctx.hasPendingMessages()) {
        cycle = "reviewed";
        return;
      }
      if (!config.configured) {
        if (!setupWarningShown) {
          warnIfSetupRequired(ctx, config, () => {
            setupWarningShown = true;
          });
        }
        cycle = "reviewed";
        return;
      }

      const candidate = assistantText(event.message);
      if (!candidate) return;

      cycle = "reviewed";
      statusContext = ctx;
      const allowRevision = cooldownRemaining === 0;
      if (cooldownRemaining > 0) cooldownRemaining -= 1;
      pendingReview = {
        allowRevision,
        candidate,
        config: { ...config },
        configRevision,
        ctx,
        generation,
        messages: activeContextMessages(ctx),
        metrics,
        sessionEpoch,
      };
      refreshReviewStatus();
      void drainReviewQueue();
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
    suppressedFindings: 0,
    totalTokens: 0,
  };
}

function activeContextMessages(ctx: ExtensionContext): unknown[] {
  return ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
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

function isReviewCandidate(event: TurnEndEvent): boolean {
  const message = event.message;
  if (!isRecord(message) || message.role !== "assistant") return false;
  if (message.stopReason !== "stop") return false;
  if (event.toolResults.length > 0 || !Array.isArray(message.content)) return false;
  if (message.content.some((part) => isRecord(part) && part.type === "toolCall")) return false;
  return Boolean(assistantText(message));
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
  assistantText,
  isGenuineUserMessage,
  isReviewCandidate,
};
