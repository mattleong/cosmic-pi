import { describe, expect, it } from "vitest";
import { makeLocalPiUsage } from "../src/backend/local-pi-usage.ts";

const stats = (input: number, cost = input / 100) => ({
  tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0, total: input },
  cost,
});

describe("Pi cumulative usage", () => {
  it("excludes copied history and deduplicates snapshots across retained assignments", () => {
    const { account } = makeLocalPiUsage();
    expect(account(stats(100))).toBeUndefined();
    expect(account(stats(110))?.input).toBe(10);
    expect(account(stats(110))).toBeUndefined();
    expect(account(stats(115))?.input).toBe(5);
  });
  it("keeps the high water mark through malformed and lower snapshots", () => {
    const { account } = makeLocalPiUsage();
    account(stats(100));
    expect(account(stats(50))).toBeUndefined();
    expect(account(stats(Infinity))).toBeUndefined();
    expect(account({})).toBeUndefined();
    expect(account(stats(110))?.input).toBe(10);
  });
  it("accounts idle warming cost even without new assistant tokens", () => {
    const { account } = makeLocalPiUsage();
    account(stats(100));
    expect(account(stats(100, 2))).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: 1,
    });
  });
});
