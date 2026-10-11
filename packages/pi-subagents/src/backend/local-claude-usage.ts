import type { SubagentUsage } from "../run/model.ts";
import { rememberBounded } from "./local-claude-correlation.ts";

const ASSISTANT_USAGE_MESSAGE_LIMIT = 32;

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
    clearMessageHistory: (): void => assistantUsageByMessage.clear(),
  };
};
