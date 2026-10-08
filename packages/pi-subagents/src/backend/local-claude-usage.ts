import type { SubagentUsage } from "../run/model.ts";
import { rememberBounded } from "./local-claude-correlation.ts";

const ASSISTANT_USAGE_MESSAGE_LIMIT = 32;

/** Cumulative native usage components tracked for monotone delta accounting. */
export type UsageComponents = Omit<SubagentUsage, "totalTokens" | "cost">;

export const zeroUsageComponents: UsageComponents = {
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

interface CumulativeUsageDelta {
  readonly delta: UsageComponents;
  readonly inconsistent: boolean;
}

/**
 * Nonnegative componentwise delta between cumulative native usage snapshots.
 * A regressing native total is reported as inconsistent and never subtracted.
 */
const cumulativeUsageDelta = (
  previous: UsageComponents,
  next: UsageComponents,
): CumulativeUsageDelta => ({
  delta: nonnegativeDelta(previous, next),
  inconsistent:
    next.input < previous.input ||
    next.output < previous.output ||
    next.cacheRead < previous.cacheRead ||
    next.cacheWrite < previous.cacheWrite,
});

export const usageComponentsTotal = (components: UsageComponents): number =>
  components.input + components.output + components.cacheRead + components.cacheWrite;

/** Synchronous token bookkeeping; the driver owns query correlation and event emission. */
export const makeLocalClaudeUsage = () => {
  const assistantUsageByMessage = new Map<string, UsageComponents>();
  let emittedUsageTotals: UsageComponents = zeroUsageComponents;

  const assistantDelta = (
    messageId: string | undefined,
    usage: UsageComponents,
  ): CumulativeUsageDelta => {
    const previous = messageId ? assistantUsageByMessage.get(messageId) : undefined;
    const result = cumulativeUsageDelta(previous ?? zeroUsageComponents, usage);
    if (messageId)
      rememberBounded(
        assistantUsageByMessage,
        messageId,
        componentwiseMax(previous ?? zeroUsageComponents, usage),
        ASSISTANT_USAGE_MESSAGE_LIMIT,
      );
    emittedUsageTotals = addUsageComponents(emittedUsageTotals, result.delta);
    return result;
  };

  const resultDelta = (
    baseline: UsageComponents,
    usage: UsageComponents | undefined,
  ): CumulativeUsageDelta => {
    // Only the already-emitted amount since this query's registration offsets
    // its final usage. Correlation takes each result expectation exactly once.
    const emittedForQuery = cumulativeUsageDelta(baseline, emittedUsageTotals).delta;
    const result = usage
      ? cumulativeUsageDelta(emittedForQuery, usage)
      : { delta: zeroUsageComponents, inconsistent: false };
    emittedUsageTotals = addUsageComponents(emittedUsageTotals, result.delta);
    return result;
  };

  return {
    assistantDelta,
    resultDelta,
    baseline: (): UsageComponents => ({ ...emittedUsageTotals }),
    // Transport cancellation clears message history, not the emitted watermark.
    clearMessageHistory: (): void => assistantUsageByMessage.clear(),
  };
};
