import { supportsFastModel } from "pi-better-openai/fast-models";
import type { AdvisorReviewPolicy, ResolvedAdvisorConfig } from "../config/options.ts";
import { safeAdvisorLabel } from "../domain/label.ts";
import type { AdvisorSessionMetrics } from "../domain/metrics.ts";

export function formatLastReview(metrics: Readonly<AdvisorSessionMetrics>): string {
  if (!metrics.lastAction) return "none";
  const duration =
    metrics.latestDurationMs === undefined
      ? ""
      : ` in ${(metrics.latestDurationMs / 1_000).toFixed(1)}s`;
  return `${metrics.lastAction}${duration}`;
}

export function formatDuration(milliseconds: number): string {
  return `${milliseconds / 1_000}s`;
}

export function formatPercent(value: number, total: number): string {
  return total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "not available";
}

export function formatUsageDuration(milliseconds: number): string {
  return milliseconds < 1_000
    ? `${Math.round(milliseconds)}ms`
    : `${(milliseconds / 1_000).toFixed(1)}s`;
}

export function formatList(values: readonly string[] | undefined): string {
  return values && values.length > 0 ? values.join(", ") : "none";
}

export function formatModel(config: Pick<ResolvedAdvisorConfig, "provider" | "model">): string {
  return config.provider && config.model
    ? `${safeAdvisorLabel(config.provider)}/${safeAdvisorLabel(config.model)}`
    : "not configured";
}

export function formatPolicy(policy: AdvisorReviewPolicy): string {
  return policy[0]!.toUpperCase() + policy.slice(1);
}

export function formatFastMode(
  config: Pick<ResolvedAdvisorConfig, "fastMode" | "provider" | "model">,
): string {
  if (!config.fastMode) return "disabled";
  return supportsFastModel(config.provider, config.model)
    ? "enabled (active)"
    : "enabled (inactive for unsupported model)";
}

export function formatSkippedReviews(skipped: Readonly<Record<string, number>>): string {
  const entries = Object.entries(skipped).filter(([, count]) => count > 0);
  return entries.length > 0
    ? entries.map(([reason, count]) => `${reason} ${count}`).join(", ")
    : "none";
}
