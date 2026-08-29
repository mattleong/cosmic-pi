/** Pure session metrics helpers for the Advisor lifecycle. */
import type { AdvisorSessionMetrics } from "../../domain/metrics.ts";
import type { AdvisorUsageTelemetry } from "../../runtime/client.ts";
import { incrementBounded } from "../controller-helpers.ts";

export const recordUsageMetrics = (
  target: AdvisorSessionMetrics,
  usage: AdvisorUsageTelemetry,
): AdvisorSessionMetrics => ({
  ...target,
  cost: target.cost + usage.cost,
  modelResponses: incrementBounded(target.modelResponses),
  totalTokens: target.totalTokens + usage.totalTokens,
});

export const recordReviewDurationMetrics = (
  target: AdvisorSessionMetrics,
  startedAt: number,
  now: number,
): AdvisorSessionMetrics => {
  const duration = Math.max(0, now - startedAt);
  return {
    ...target,
    latestDurationMs: duration,
    settledReviews: incrementBounded(target.settledReviews),
    totalDurationMs: target.totalDurationMs + duration,
  };
};
