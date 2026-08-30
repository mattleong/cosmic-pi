import type { AdvisorUsageTelemetry } from "../runtime/client.ts";

export function incrementBounded(value: number | undefined): number {
  return Math.min(Number.MAX_SAFE_INTEGER, (value ?? 0) + 1);
}

/** Visible metrics for the current Advisor session. */
export interface AdvisorSessionMetrics {
  readonly cards: number;
  readonly corrections: number;
  readonly cost: number;
  readonly lastAction?:
    | "advice"
    | "discarded"
    | "failure"
    | "guidance"
    | "pass"
    | "perspective"
    | "recovery"
    | "revision"
    | "suppressed";
  readonly latestDurationMs?: number;
  readonly modelResponses: number;
  readonly settledReviews: number;
  readonly totalDurationMs: number;
  readonly totalTokens: number;
}

export const emptyAdvisorSessionMetrics = (): AdvisorSessionMetrics => ({
  cards: 0,
  corrections: 0,
  cost: 0,
  modelResponses: 0,
  settledReviews: 0,
  totalDurationMs: 0,
  totalTokens: 0,
});

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
