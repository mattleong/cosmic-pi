import { describe, expect, it } from "vitest";
import { localClaudeUsage } from "../src/backend/local-claude-usage.ts";

const tokens = (input = 0, output = 0, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});

describe("Claude usage bookkeeping", () => {
  it("deduplicates cumulative messages, including caches, without subtracting regressions", () => {
    const usage = localClaudeUsage();
    const first = tokens(3, 4, 5, 6);
    expect(usage.assistantDelta("message", first)).toEqual({ delta: first, inconsistent: false });
    expect(usage.assistantDelta("message", first)).toEqual({
      delta: tokens(),
      inconsistent: false,
    });
    expect(usage.assistantDelta("message", tokens(1, 7, 2, 9))).toEqual({
      delta: tokens(0, 3, 0, 3),
      inconsistent: true,
    });
    expect(usage.assistantDelta("message", first).delta).toEqual(tokens());
    expect(usage.resultDelta(tokens(3, 7, 5, 9), undefined).delta).toEqual(tokens());
  });

  it("keeps the 32 most recently observed message IDs", () => {
    const usage = localClaudeUsage();
    for (let index = 0; index < 32; index++) usage.assistantDelta(`message-${index}`, tokens(1));
    usage.assistantDelta("message-0", tokens(1));
    usage.assistantDelta("message-32", tokens(1));
    expect(usage.assistantDelta("message-0", tokens(1)).delta).toEqual(tokens());
    expect(usage.assistantDelta("message-1", tokens(1)).delta).toEqual(tokens(1));
    expect(usage.resultDelta(tokens(34), undefined).delta).toEqual(tokens());
  });

  it("accounts anonymous messages separately and clears history without resetting totals", () => {
    const usage = localClaudeUsage();
    usage.assistantDelta(undefined, tokens(2));
    usage.assistantDelta(undefined, tokens(2));
    usage.assistantDelta("message", tokens(3));
    usage.clearMessageHistory();
    expect(usage.assistantDelta("message", tokens(3)).delta).toEqual(tokens(3));
    expect(usage.resultDelta(tokens(10), undefined).delta).toEqual(tokens());
  });

  it("adds only what earlier events have not counted from each running result total", () => {
    const usage = localClaudeUsage();
    usage.assistantDelta("first-turn", tokens(3, 4, 5, 6));
    expect(usage.resultDelta(tokens(8, 9, 10, 11), undefined)).toEqual({
      delta: tokens(5, 5, 5, 5),
      inconsistent: false,
    });
    usage.assistantDelta("second-turn", tokens(1, 1, 1, 1));
    expect(usage.resultDelta(tokens(10, 10, 12, 12), undefined)).toEqual({
      delta: tokens(1, 0, 1, 0),
      inconsistent: false,
    });
  });

  it("charges each result only the increase of the running cost", () => {
    const usage = localClaudeUsage();
    const costs = [0.01, 0.025, 0.025, 0.04].map(
      (total) => usage.resultDelta(undefined, total).cost ?? Number.NaN,
    );
    expect(costs.reduce((sum, cost) => sum + cost, 0)).toBeCloseTo(0.04);
    expect(costs[2]).toBe(0);
    expect(usage.resultDelta(tokens(1), undefined).cost).toBeUndefined();
  });

  it("ignores zeroed crash results and never subtracts a regressing total", () => {
    const usage = localClaudeUsage();
    expect(usage.resultDelta(tokens(10), 0.02)).toMatchObject({ delta: tokens(10) });
    expect(usage.resultDelta(tokens(), 0)).toEqual({
      delta: tokens(),
      inconsistent: false,
      cost: 0,
    });
    expect(usage.resultDelta(tokens(5), 0.01)).toEqual({
      delta: tokens(),
      inconsistent: true,
      cost: 0,
    });
    expect(usage.resultDelta(tokens(12), 0.03)).toMatchObject({ delta: tokens(2) });
    expect(usage.resultDelta(undefined, 0.03).cost).toBe(0);
  });
});
