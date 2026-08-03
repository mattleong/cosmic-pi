import type { ResolvedAdvisorConfig } from "../config/options.ts";
import { safeAdvisorLabel } from "../domain/label.ts";
import type { AdvisorSessionMetrics } from "../domain/metrics.ts";

export function formatLastReview(metrics: Readonly<AdvisorSessionMetrics>): string {
  if (!metrics.lastAction) return "none yet";
  const labels: Record<NonNullable<AdvisorSessionMetrics["lastAction"]>, string> = {
    advice: "issue shown",
    discarded: "review discarded",
    failure: "review unavailable",
    guidance: "course corrected",
    pass: "no issues",
    perspective: "suggestion shown",
    recovery: "stalled work recovered",
    revision: "response corrected",
    suppressed: "no new issues",
  };
  const duration =
    metrics.latestDurationMs === undefined
      ? ""
      : ` in ${(metrics.latestDurationMs / 1_000).toFixed(1)}s`;
  return `${labels[metrics.lastAction]}${duration}`;
}

export function formatUsageDuration(milliseconds: number): string {
  return milliseconds < 1_000
    ? `${Math.round(milliseconds)}ms`
    : `${(milliseconds / 1_000).toFixed(1)}s`;
}

export function formatModel(config: Pick<ResolvedAdvisorConfig, "provider" | "model">): string {
  return config.provider && config.model
    ? `${safeAdvisorLabel(config.provider)}/${safeAdvisorLabel(config.model)}`
    : "not configured";
}
