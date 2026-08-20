import { describe, expect, it } from "vitest";
import { makeHostCallbackBoundary } from "../src/boundary/host-callback.ts";
import {
  materializeContextUsage,
  materializeModel,
} from "../src/boundary/host-footer-projection.ts";
import {
  addAssistantUsage,
  decodeAssistantUsage,
  decodeContextUsage,
  decodeHostCount,
} from "../src/boundary/host-usage.ts";
import { extensionContextFixture } from "./support/host.ts";

const validUsage = {
  input: 1,
  output: 2,
  cacheRead: 3,
  cacheWrite: 4,
  cost: { total: 0.25 },
};

describe("host numeric decoding", () => {
  it.each([
    ["negative", { ...validUsage, input: -1 }],
    ["NaN", { ...validUsage, output: Number.NaN }],
    ["infinity", { ...validUsage, cacheRead: Number.POSITIVE_INFINITY }],
    ["negative cost", { ...validUsage, cost: { total: -1 } }],
  ])("rejects %s assistant usage", (_name, usage) => {
    expect(decodeAssistantUsage(usage)).toBeUndefined();
  });

  it("rejects aggregate overflow without mutating complete totals", () => {
    const totals = {
      input: Number.MAX_VALUE,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    };
    const usage = decodeAssistantUsage({ ...validUsage, input: Number.MAX_VALUE });
    expect(usage).toBeDefined();
    if (!usage) return;

    expect(addAssistantUsage(totals, usage)).toBeUndefined();
    expect(totals.input).toBe(Number.MAX_VALUE);
  });

  it("rejects non-negative-finite context and model counts before rendering", () => {
    expect(decodeContextUsage({ tokens: null, contextWindow: 100_000, percent: null })).toEqual({
      tokens: null,
      contextWindow: 100_000,
      percent: null,
    });
    expect(
      decodeContextUsage({ tokens: Number.NaN, contextWindow: 100_000, percent: 10 }),
    ).toBeUndefined();
    expect(decodeHostCount(-1)).toBeUndefined();
    expect(decodeHostCount(Number.POSITIVE_INFINITY)).toBeUndefined();

    const callbacks = makeHostCallbackBoundary();
    const invalidModel = extensionContextFixture({
      model: {
        id: "model",
        provider: "provider",
        reasoning: false,
        contextWindow: Number.POSITIVE_INFINITY,
      },
    });
    expect(materializeModel(invalidModel, callbacks)).toBeUndefined();

    const invalidContext = extensionContextFixture({
      getContextUsage: () => ({ contextWindow: 100_000, tokens: -1, percent: 10 }),
    });
    expect(materializeContextUsage(invalidContext, callbacks)).toBeUndefined();
  });
});
