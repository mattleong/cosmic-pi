import { formatTokens, formatCost } from "pi-cosmic-core";

interface FormatUsageInput {
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
