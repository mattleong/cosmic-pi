import {
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { requestAdvisorReview } from "./client.ts";
import { loadAdvisorConfig, type ResolvedAdvisorConfig } from "./config.ts";
import { buildAdvisorContext } from "./context.ts";
import { ADVISOR_REVIEW_MESSAGE_TYPE, registerAdvisorReviewRenderer } from "./renderer.ts";
import { buildRevisionSteer, type AdvisorReview } from "./review.ts";
import { type AdvisorSessionMetrics, registerAdvisorCommands } from "./settings.ts";

const STATUS_KEY = "pi-advisor";

type ReviewCycleState = "eligible" | "reviewing" | "reviewed";

export interface AdvisorExtensionDependencies {
  loadConfig?: typeof loadAdvisorConfig;
  requestReview?: typeof requestAdvisorReview;
}

export function createAdvisorExtension(dependencies: AdvisorExtensionDependencies = {}) {
  const loadConfig = dependencies.loadConfig ?? loadAdvisorConfig;
  const runReview = dependencies.requestReview ?? requestAdvisorReview;

  return function registerAdvisorExtension(pi: ExtensionAPI): void {
    let config = loadConfig();
    let configRevision = 0;
    let cycle: ReviewCycleState = "eligible";
    let metrics = emptySessionMetrics();
    let setupWarningShown = false;

    registerAdvisorReviewRenderer(pi);
    registerAdvisorCommands(pi, {
      get: () => config,
      getMetrics: () => metrics,
      update: (next) => {
        config = next;
        configRevision += 1;
        if (next.configured || !next.enabled) setupWarningShown = false;
      },
    });

    pi.on("session_start", (_event, ctx) => {
      config = loadConfig(config.configPath);
      configRevision += 1;
      cycle = "eligible";
      metrics = emptySessionMetrics();
      setupWarningShown = false;
      ctx.ui.setStatus(STATUS_KEY, undefined);
      warnIfSetupRequired(ctx, config, () => {
        setupWarningShown = true;
      });
    });

    pi.on("session_shutdown", (_event, ctx) => {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    });

    pi.on("before_agent_start", () => {
      cycle = "eligible";
    });

    pi.on("message_end", (event) => {
      if (isGenuineUserMessage(event.message)) cycle = "eligible";
    });

    pi.on("turn_end", async (event, ctx) => {
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

      cycle = "reviewing";
      const attemptMetrics = metrics;
      attemptMetrics.attempted += 1;
      const reviewConfig = { ...config };
      const reviewConfigRevision = configRevision;
      const reviewIsCurrent = () =>
        configRevision === reviewConfigRevision &&
        !ctx.hasPendingMessages() &&
        config.enabled &&
        config.configured &&
        config.provider === reviewConfig.provider &&
        config.model === reviewConfig.model;
      ctx.ui.setStatus(STATUS_KEY, "advisor: reviewing…");
      try {
        const messages = activeContextMessages(ctx);
        const reviewContext = buildAdvisorContext({
          messages,
          candidate,
          maxChars: reviewConfig.maxContextChars,
        });
        const review = await runReview(ctx, reviewConfig, reviewContext.transcript);
        cycle = "reviewed";
        if (!reviewIsCurrent()) {
          attemptMetrics.discarded += 1;
          return;
        }
        if (review.verdict === "pass") {
          ctx.ui.notify("Advisor approved this response.", "info");
          attemptMetrics.pass += 1;
          return;
        }
        sendRevisionRequest(pi, reviewConfig, review);
        attemptMetrics.revise += 1;
      } catch {
        cycle = "reviewed";
        if (reviewIsCurrent()) {
          attemptMetrics.failure += 1;
          ctx.ui.notify("Advisor review failed; keeping the original response.", "warning");
        } else {
          attemptMetrics.discarded += 1;
        }
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    });
  };
}

export const advisorExtension = createAdvisorExtension();

function emptySessionMetrics(): AdvisorSessionMetrics {
  return { attempted: 0, pass: 0, revise: 0, failure: 0, discarded: 0 };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const _extensionTest = {
  activeContextMessages,
  assistantText,
  isGenuineUserMessage,
  isReviewCandidate,
};
