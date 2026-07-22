/** Pure session metrics helpers for the advisor lifecycle. */
import { stringifyJson } from "../../boundary/json.ts";
import type { AdvisorSessionMetrics } from "../../domain/metrics.ts";
import type { AdvisorUsageTelemetry } from "../../runtime/client.ts";
import type { ResolvedAdvisorConfig } from "../../config/options.ts";
import { incrementBounded } from "../controller-helpers.ts";

export const cloneSessionMetrics = (current: AdvisorSessionMetrics): AdvisorSessionMetrics => ({
  ...current,
  outcomes: { ...current.outcomes },
  skippedReviews: { ...current.skippedReviews },
  usageByModel: Object.fromEntries(
    Object.entries(current.usageByModel ?? {}).map(([key, usage]) => [key, { ...usage }]),
  ),
});

export const recordUsageMetrics = (
  target: AdvisorSessionMetrics,
  usage: AdvisorUsageTelemetry,
  runtimeConfig: ResolvedAdvisorConfig,
): AdvisorSessionMetrics => {
  const next = cloneSessionMetrics(target);
  next.cacheReadTokens = (next.cacheReadTokens ?? 0) + usage.cacheReadTokens;
  next.cacheWriteTokens = (next.cacheWriteTokens ?? 0) + usage.cacheWriteTokens;
  next.cost = (next.cost ?? 0) + usage.cost;
  next.inputTokens = (next.inputTokens ?? 0) + usage.inputTokens;
  next.modelResponses = incrementBounded(next.modelResponses);
  next.outputTokens = (next.outputTokens ?? 0) + usage.outputTokens;
  next.totalTokens = (next.totalTokens ?? 0) + usage.totalTokens;

  const provider = runtimeConfig.provider ?? "unknown";
  const model = runtimeConfig.model ?? "unknown";
  const key = stringifyJson([provider, model]);
  const previous = next.usageByModel?.[key];
  next.usageByModel = {
    ...next.usageByModel,
    [key]: {
      provider,
      model,
      responses: incrementBounded(previous?.responses),
      cacheReadTokens: (previous?.cacheReadTokens ?? 0) + usage.cacheReadTokens,
      cacheWriteTokens: (previous?.cacheWriteTokens ?? 0) + usage.cacheWriteTokens,
      cost: (previous?.cost ?? 0) + usage.cost,
      inputTokens: (previous?.inputTokens ?? 0) + usage.inputTokens,
      outputTokens: (previous?.outputTokens ?? 0) + usage.outputTokens,
      totalTokens: (previous?.totalTokens ?? 0) + usage.totalTokens,
    },
  };
  return next;
};

export const recordReviewDurationMetrics = (
  target: AdvisorSessionMetrics,
  startedAt: number,
  now: number,
): AdvisorSessionMetrics => {
  const next = cloneSessionMetrics(target);
  const duration = Math.max(0, now - startedAt);
  next.latestDurationMs = duration;
  next.settledReviews = incrementBounded(next.settledReviews);
  next.totalDurationMs = (next.totalDurationMs ?? 0) + duration;
  return next;
};
