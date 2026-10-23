import * as Arr from "effect/Array";
import { formatTokens, formatCost } from "pi-cosmic-core";

interface FormatUsageInput {
  readonly totalTokens: number;
  readonly cost?: number | undefined;
}

export const aggregateUsage = (
  runs: ReadonlyArray<{ readonly usage?: FormatUsageInput | undefined }>,
  style: "long" | "compact" = "long",
): string => {
  const tokens = Arr.reduce(runs, 0, (total, run) => total + (run.usage?.totalTokens ?? 0));
  const knownCosts = Arr.flatMap(runs, (run) =>
    run.usage?.cost === undefined ? [] : [run.usage.cost],
  );
  const cost = Arr.reduce(knownCosts, 0, (total, value) => total + value);
  const costKnown = knownCosts.length > 0;
  const partial = costKnown && knownCosts.length < runs.length;
  if (tokens <= 0 && (!costKnown || cost === 0)) return "";
  const lowerBound = partial ? (style === "compact" ? "≥" : "≥ ") : "";
  const costPart = costKnown ? ` · ${lowerBound}${formatCost(cost)}` : "";
  return `${formatTokens(tokens)} ${style === "compact" ? "tok" : "tokens"}${costPart}`;
};
