import { isRecord } from "./utils.ts";
import {
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
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
  buildRevisionSteer,
  type AdvisorReview,
  type AdvisorReviewFocus,
} from "./review.ts";
import {
  type AdvisorCommandActions,
  type AdvisorSessionMetrics,
  registerAdvisorCommands,
} from "./settings.ts";

const STATUS_KEY = "pi-advisor";

type ReviewCycleState = "eligible" | "reviewed";
type RevisionThreshold = "none" | "high" | "medium";
type ReviewSource = "automatic" | "next" | "last" | "verify";

export type AdvisorSkipReason =
  | "advisor-revision"
  | "cycle-complete"
  | "disabled"
  | "empty"
  | "incomplete"
  | "manual-policy"
  | "pending-input"
  | "session-paused"
  | "tool-call"
  | "unconfigured";

interface PendingIntervention {
  review: AdvisorReview;
  reviewJob: PendingReview;
}

interface PendingReview {
  candidate: string;
  config: ResolvedAdvisorConfig;
  configRevision: number;
  cooldownBlocked: boolean;
  ctx: ExtensionContext;
  focus: AdvisorReviewFocus;
  generation: number;
  messages: unknown[];
  metrics: AdvisorSessionMetrics;
  requiresEnabled: boolean;
  revisionThreshold: RevisionThreshold;
  scope: string;
  sessionEpoch: number;
  source: ReviewSource;
  workEpoch: number;
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
    let cycle: ReviewCycleState = "eligible";
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
    let activeReview: PendingReview | undefined;
    let activeController: AbortController | undefined;
    let draining = false;
    let statusContext: ExtensionContext | undefined;
    let revisionGeneration: number | undefined;
    let sessionPaused = false;
    let reviewNext = false;
    let lastCandidate: LastCandidate | undefined;

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

    const clearBackgroundReviews = (ctx?: ExtensionContext): boolean => {
      const cleared = Boolean(pendingReview || pendingIntervention || activeReview);
      workEpoch += 1;
      pendingReview = undefined;
      pendingIntervention = undefined;
      activeController?.abort();
      (ctx ?? statusContext)?.ui.setStatus(STATUS_KEY, undefined);
      return cleared;
    };

    const reviewIsCurrent = (review: PendingReview): boolean =>
      review.sessionEpoch === sessionEpoch &&
      review.generation === generation &&
      review.workEpoch === workEpoch &&
      review.configRevision === configRevision &&
      (!review.requiresEnabled || config.enabled) &&
      config.configured &&
      config.provider === review.config.provider &&
      config.model === review.config.model &&
      !review.ctx.hasPendingMessages();

    const refreshReviewStatus = (): void => {
      if (!statusContext) return;
      if (sessionPaused) {
        statusContext.ui.setStatus(STATUS_KEY, "advisor: paused");
        return;
      }
      if (pendingIntervention !== undefined && reviewIsCurrent(pendingIntervention.reviewJob)) {
        statusContext.ui.setStatus(STATUS_KEY, "advisor: revision pending…");
        return;
      }
      const hasCurrentReview =
        (activeReview !== undefined && reviewIsCurrent(activeReview)) ||
        (pendingReview !== undefined && reviewIsCurrent(pendingReview));
      statusContext.ui.setStatus(STATUS_KEY, hasCurrentReview ? "advisor: reviewing…" : undefined);
    };

    const deliverReview = (reviewJob: PendingReview, review: AdvisorReview): void => {
      const filtered = findingDedupe.filter(review.findings, reviewJob.scope);
      reviewJob.metrics.suppressedFindings =
        (reviewJob.metrics.suppressedFindings ?? 0) + filtered.suppressed;
      if (filtered.findings.length === 0) {
        reviewJob.metrics.lastAction = "suppressed";
        return;
      }

      if (reviewJob.cooldownBlocked && cooldownRemaining > 0) cooldownRemaining -= 1;
      const filteredReview = { ...review, findings: filtered.findings };
      if (shouldRevise(reviewJob.revisionThreshold, filteredReview)) {
        sendRevisionRequest(pi, reviewJob.config, filteredReview);
        cooldownRemaining = reviewJob.config.revisionCooldownTurns;
        reviewJob.metrics.lastAction = "revision";
        revisionGeneration = reviewJob.generation;
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
      candidate: string;
      ctx: ExtensionContext;
      focus?: AdvisorReviewFocus;
      messages: unknown[];
      requiresEnabled: boolean;
      revisionThreshold: RevisionThreshold;
      source: ReviewSource;
    }): void => {
      const cooldownBlocked = cooldownRemaining > 0;
      pendingReview = {
        candidate: options.candidate,
        config: { ...config },
        configRevision,
        cooldownBlocked,
        ctx: options.ctx,
        focus: options.focus ?? "standard",
        generation,
        messages: options.messages,
        metrics,
        requiresEnabled: options.requiresEnabled,
        revisionThreshold: cooldownBlocked ? "none" : options.revisionThreshold,
        scope: `${sessionEpoch}:${generation}`,
        sessionEpoch,
        source: options.source,
        workEpoch,
      };
      statusContext = options.ctx;
      refreshReviewStatus();
      void drainReviewQueue();
    };

    const commandActions: AdvisorCommandActions = {
      cancel: (ctx) => {
        statusContext = ctx;
        const hadNextReview = reviewNext;
        reviewNext = false;
        const cleared = clearBackgroundReviews(ctx);
        refreshReviewStatus();
        return cleared || hadNextReview;
      },
      pause: (ctx) => {
        statusContext = ctx;
        sessionPaused = true;
        reviewNext = false;
        clearBackgroundReviews(ctx);
        refreshReviewStatus();
      },
      resume: (ctx) => {
        statusContext = ctx;
        sessionPaused = false;
        refreshReviewStatus();
      },
      reviewLast: (ctx, focus) => {
        if (!lastCandidate || lastCandidate.sessionEpoch !== sessionEpoch) return false;
        clearBackgroundReviews(ctx);
        enqueueReview({
          candidate: lastCandidate.candidate,
          ctx,
          focus,
          messages: lastCandidate.messages,
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
          clearBackgroundReviews();
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
      cycle = "eligible";
      metrics = emptySessionMetrics();
      cooldownRemaining = 0;
      findingDedupe.reset();
      reportedFailureKinds.clear();
      instructions = loadAdvisorInstructions(config.configPath, ctx.cwd, ctx.isProjectTrusted());
      setupWarningShown = false;
      statusContext = ctx;
      revisionGeneration = undefined;
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
      cycle = "eligible";
      revisionGeneration = undefined;
      lastCandidate = undefined;
      findingDedupe.reset();
      clearBackgroundReviews(ctx);
      refreshReviewStatus();
    });

    pi.on("agent_settled", (_event, ctx) => {
      const intervention = pendingIntervention;
      pendingIntervention = undefined;
      if (!intervention || !reviewIsCurrent(intervention.reviewJob) || !ctx.isIdle()) {
        refreshReviewStatus();
        return;
      }
      deliverReview(intervention.reviewJob, intervention.review);
      refreshReviewStatus();
    });

    pi.on("turn_end", (event, ctx) => {
      const classification = classifyReviewCandidate(event);
      if (!classification.eligible) {
        if (classification.reason !== "not-assistant") recordSkip(classification.reason);
        return;
      }

      const candidate = classification.candidate;
      const messages = activeContextMessages(ctx);
      lastCandidate = { candidate, generation, messages, sessionEpoch };

      if (revisionGeneration === generation) {
        revisionGeneration = undefined;
        cycle = "reviewed";
        recordSkip("advisor-revision");
        return;
      }
      if (cycle !== "eligible") {
        recordSkip("cycle-complete");
        return;
      }
      if (ctx.hasPendingMessages()) {
        cycle = "reviewed";
        recordSkip("pending-input");
        return;
      }

      const explicitlyRequested = reviewNext;
      if (explicitlyRequested) reviewNext = false;
      if (!explicitlyRequested) {
        if (!config.enabled) {
          cycle = "reviewed";
          recordSkip("disabled");
          return;
        }
        if (sessionPaused) {
          cycle = "reviewed";
          recordSkip("session-paused");
          return;
        }
        if (config.reviewPolicy === "manual") {
          cycle = "reviewed";
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
        cycle = "reviewed";
        recordSkip("unconfigured");
        return;
      }

      cycle = "reviewed";
      enqueueReview({
        candidate,
        ctx,
        messages,
        requiresEnabled: !explicitlyRequested,
        revisionThreshold: thresholdForPolicy(config.reviewPolicy),
        source: explicitlyRequested ? "next" : "automatic",
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
  | { eligible: true; candidate: string }
  | {
      eligible: false;
      reason: "not-assistant" | "empty" | "incomplete" | "tool-call";
    };

function classifyReviewCandidate(event: TurnEndEvent): CandidateClassification {
  const message = event.message;
  if (!isRecord(message) || message.role !== "assistant") {
    return { eligible: false, reason: "not-assistant" };
  }
  if (message.stopReason !== "stop") return { eligible: false, reason: "incomplete" };
  if (!Array.isArray(message.content)) return { eligible: false, reason: "empty" };
  if (message.content.some((part) => isRecord(part) && part.type === "toolCall")) {
    return { eligible: false, reason: "tool-call" };
  }
  const candidate = assistantText(message);
  return candidate ? { eligible: true, candidate } : { eligible: false, reason: "empty" };
}

function isReviewCandidate(event: TurnEndEvent): boolean {
  return classifyReviewCandidate(event).eligible;
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
  classifyFailure,
  classifyReviewCandidate,
  isGenuineUserMessage,
  isReviewCandidate,
  shouldRevise,
  thresholdForPolicy,
};
