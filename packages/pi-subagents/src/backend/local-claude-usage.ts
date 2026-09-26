import {
  addUsageComponents,
  componentwiseMax,
  cumulativeUsageDelta,
  rememberBounded,
  zeroUsageComponents,
  type CumulativeUsageDelta,
  type UsageComponents,
} from "./local-claude-correlation.ts";

const ASSISTANT_USAGE_MESSAGE_LIMIT = 32;

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
