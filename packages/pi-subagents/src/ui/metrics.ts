export const formatTokenCount = (tokens: number): string => {
  const value = Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 1_000_000)
    return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}m`;
};

export const formatCost = (cost: number): string => {
  const value = Number.isFinite(cost) ? Math.max(0, cost) : 0;
  if (value === 0) return "$0";
  if (value < 0.0001) return "$<0.0001";
  if (value < 0.01) return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${value.toFixed(2)}`;
};

export interface FormatUsageInput {
  readonly totalTokens: number;
  readonly cost?: number | undefined;
}

/**
 * Renders known usage only. Unknown cost is omitted rather than shown as `$0`,
 * and usage with no tokens and no positive known cost renders nothing.
 */
export const formatUsage = (
  usage: FormatUsageInput | undefined,
  tokensLabel = "tokens",
): string => {
  if (!usage) return "";
  const hasTokens = Number.isFinite(usage.totalTokens) && usage.totalTokens > 0;
  const hasCost = usage.cost !== undefined && Number.isFinite(usage.cost);
  if (!hasTokens && (!hasCost || usage.cost === 0)) return "";
  const parts = [
    `${formatTokenCount(usage.totalTokens)} ${tokensLabel}`,
    ...(hasCost ? [formatCost(usage.cost ?? 0)] : []),
  ];
  return parts.join(" · ");
};

export const formatDuration = (milliseconds: number): string => {
  const safe = Math.max(0, Math.floor(milliseconds));
  if (safe < 1_000) return `${safe}ms`;
  const seconds = Math.floor(safe / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};
