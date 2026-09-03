import { formatTokens } from "pi-cosmic-core";

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

export const aggregateUsage = (
  runs: ReadonlyArray<{ readonly usage?: FormatUsageInput | undefined }>,
  style: "long" | "compact" = "long",
): string => {
  const tokens = runs.reduce((total, run) => total + (run.usage?.totalTokens ?? 0), 0);
  const knownCosts = runs.flatMap((run) => (run.usage?.cost === undefined ? [] : [run.usage.cost]));
  const cost = knownCosts.reduce((total, value) => total + value, 0);
  const costKnown = knownCosts.length > 0;
  const partial = costKnown && knownCosts.length < runs.length;
  if (tokens <= 0 && (!costKnown || cost === 0)) return "";
  const lowerBound = partial ? (style === "compact" ? "≥" : "≥ ") : "";
  const costPart = costKnown ? ` · ${lowerBound}${formatCost(cost)}` : "";
  return `${formatTokens(tokens)} ${style === "compact" ? "tok" : "tokens"}${costPart}`;
};

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
    `${formatTokens(usage.totalTokens)} ${tokensLabel}`,
    ...(hasCost ? [formatCost(usage.cost ?? 0)] : []),
  ];
  return parts.join(" · ");
};

export const formatRelativeAge = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 1) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
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
