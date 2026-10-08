import { describe, expect, it } from "vitest";
import { makeLocalClaudeUsage, usageComponentsTotal } from "../src/backend/local-claude-usage.ts";

const tokens = (input = 0, output = 0, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});

describe("Claude usage bookkeeping", () => {
  it("deduplicates cumulative messages, including caches, without subtracting regressions", () => {
    const usage = makeLocalClaudeUsage();
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
    expect(usage.baseline()).toEqual(tokens(3, 7, 5, 9));
    expect(usageComponentsTotal(usage.baseline())).toBe(24);
  });

  it("keeps the 32 most recently observed message IDs", () => {
    const usage = makeLocalClaudeUsage();
    for (let index = 0; index < 32; index++) usage.assistantDelta(`message-${index}`, tokens(1));
    usage.assistantDelta("message-0", tokens(1));
    usage.assistantDelta("message-32", tokens(1));
    expect(usage.assistantDelta("message-0", tokens(1)).delta).toEqual(tokens());
    expect(usage.assistantDelta("message-1", tokens(1)).delta).toEqual(tokens(1));
    expect(usage.baseline()).toEqual(tokens(34));
  });

  it("accounts anonymous messages separately and clears history without resetting totals", () => {
    const usage = makeLocalClaudeUsage();
    usage.assistantDelta(undefined, tokens(2));
    usage.assistantDelta(undefined, tokens(2));
    usage.assistantDelta("message", tokens(3));
    usage.clearMessageHistory();
    expect(usage.baseline()).toEqual(tokens(7));
    expect(usage.assistantDelta("message", tokens(3)).delta).toEqual(tokens(3));
    expect(usage.baseline()).toEqual(tokens(10));
  });

  it("returns detached registration baselines", () => {
    const usage = makeLocalClaudeUsage();
    usage.assistantDelta("earlier", tokens(10));
    const baseline = usage.baseline();
    usage.assistantDelta("later", tokens(5));
    expect(baseline).toEqual(tokens(10));
    Object.assign(baseline, { input: 99 });
    expect(usage.baseline()).toEqual(tokens(15));
  });

  it("reconciles only the uncounted result remainder since the supplied query baseline", () => {
    const usage = makeLocalClaudeUsage();
    usage.assistantDelta("earlier-query", tokens(100, 100, 100, 100));
    const baseline = usage.baseline();
    usage.assistantDelta("query-message", tokens(3, 4, 5, 6));
    expect(usage.resultDelta(baseline, tokens(8, 9, 10, 11))).toEqual({
      delta: tokens(5, 5, 5, 5),
      inconsistent: false,
    });
    expect(usage.baseline()).toEqual(tokens(108, 109, 110, 111));
  });

  it("ignores regressing result components and leaves cost-only token totals unchanged", () => {
    const usage = makeLocalClaudeUsage();
    const baseline = usage.baseline();
    usage.assistantDelta("query-message", tokens(3, 4, 5, 6));
    expect(usage.resultDelta(baseline, tokens(1, 8, 2, 10))).toEqual({
      delta: tokens(0, 4, 0, 4),
      inconsistent: true,
    });
    const accounted = usage.baseline();
    expect(usage.resultDelta(accounted, undefined)).toEqual({
      delta: tokens(),
      inconsistent: false,
    });
    expect(usage.baseline()).toEqual(accounted);
  });
});
