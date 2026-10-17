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
