import type { SubagentUsage } from "../run/model.ts";
import { rememberBounded } from "./local-claude-correlation.ts";

const ASSISTANT_USAGE_MESSAGE_LIMIT = 32;

export type UsageComponents = Omit<SubagentUsage, "totalTokens" | "cost">;

const zeroUsageComponents: UsageComponents = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const componentwise =
  (combine: (left: number, right: number) => number) =>
  (left: UsageComponents, right: UsageComponents): UsageComponents => ({
    input: combine(left.input, right.input),
    output: combine(left.output, right.output),
    cacheRead: combine(left.cacheRead, right.cacheRead),
    cacheWrite: combine(left.cacheWrite, right.cacheWrite),
  });

const componentwiseMax = componentwise(Math.max);
const addUsageComponents = componentwise((left, right) => left + right);
const nonnegativeDelta = componentwise((previous, next) => Math.max(0, next - previous));

const regresses = (previous: UsageComponents, next: UsageComponents): boolean =>
  next.input < previous.input ||
  next.output < previous.output ||
  next.cacheRead < previous.cacheRead ||
  next.cacheWrite < previous.cacheWrite;

interface CumulativeUsageDelta {
  readonly delta: UsageComponents;
  readonly inconsistent: boolean;
}

interface ResultUsageDelta extends CumulativeUsageDelta {
  readonly cost?: number | undefined;
}

export const usageComponentsTotal = (components: UsageComponents): number =>
  components.input + components.output + components.cacheRead + components.cacheWrite;

/**
 * Accounts one Claude process. Assistant messages carry per-message usage that may repeat under
 * the same message id; each result carries the process's running token and cost totals, so a
 * result contributes only what earlier events have not already counted.
 */
export const localClaudeUsage = () => {
  const assistantUsageByMessage = new Map<string, UsageComponents>();
  let emittedUsageTotals: UsageComponents = zeroUsageComponents;
  let resultUsageTotals: UsageComponents = zeroUsageComponents;
  let resultCostUsd = 0;

  const assistantDelta = (
    messageId: string | undefined,
    usage: UsageComponents,
  ): CumulativeUsageDelta => {
    const previous = messageId ? assistantUsageByMessage.get(messageId) : undefined;
    const prior = previous ?? zeroUsageComponents;
    const result = { delta: nonnegativeDelta(prior, usage), inconsistent: regresses(prior, usage) };
    if (messageId)
      rememberBounded(
        assistantUsageByMessage,
        messageId,
        componentwiseMax(prior, usage),
        ASSISTANT_USAGE_MESSAGE_LIMIT,
      );
    emittedUsageTotals = addUsageComponents(emittedUsageTotals, result.delta);
    return result;
  };

  // Crash and startup-error results may carry zeroed totals; they never lower the watermarks.
  const resultDelta = (
    totals: UsageComponents | undefined,
    totalCostUsd: number | undefined,
  ): ResultUsageDelta => {
    const zeroed = totals === undefined || usageComponentsTotal(totals) === 0;
    const inconsistent = !zeroed && regresses(resultUsageTotals, totals);
    const delta = zeroed ? zeroUsageComponents : nonnegativeDelta(emittedUsageTotals, totals);
    if (!zeroed) resultUsageTotals = componentwiseMax(resultUsageTotals, totals);
    emittedUsageTotals = addUsageComponents(emittedUsageTotals, delta);
    if (totalCostUsd === undefined) return { delta, inconsistent };
    const cost = Math.max(0, totalCostUsd - resultCostUsd);
    resultCostUsd = Math.max(resultCostUsd, totalCostUsd);
    return { delta, inconsistent, cost };
  };

  return {
    assistantDelta,
    resultDelta,
    clearMessageHistory: (): void => assistantUsageByMessage.clear(),
  };
};
