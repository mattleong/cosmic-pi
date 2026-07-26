import { describe, expect, it } from "vitest";
import type { SubagentUsage } from "../src/run/model.ts";
import { addUsage } from "../src/run/state.ts";

const usage = (overrides: Partial<SubagentUsage> = {}): SubagentUsage => ({
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: 0.01,
  ...overrides,
});

describe("subagent usage state", () => {
  it("ignores invalid and overflowing usage updates", () => {
    const current = usage();
    expect(addUsage(current, usage({ input: -1 }))).toBe(current);
    expect(addUsage(current, usage({ cost: Number.POSITIVE_INFINITY }))).toBe(current);
    expect(addUsage(usage({ input: Number.MAX_SAFE_INTEGER }), usage({ input: 1 }))).toEqual(
      usage({ input: Number.MAX_SAFE_INTEGER }),
    );
  });
});
