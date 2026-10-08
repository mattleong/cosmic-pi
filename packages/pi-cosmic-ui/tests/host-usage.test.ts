import { describe, expect, it } from "vitest";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import {
  materializeContextUsage,
  materializeModel,
} from "../src/boundary/host-footer-projection.ts";
import { addAssistantUsage, decodeAssistantUsage } from "../src/boundary/host-usage.ts";

describe("host numeric decoding", () => {
  it("rejects aggregate overflow without mutating complete totals", () => {
    const totals = {
      input: Number.MAX_VALUE,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    };
    const usage = decodeAssistantUsage({
      input: Number.MAX_VALUE,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      cost: { total: 0.25 },
    });
    expect(usage).toBeDefined();
    if (!usage) return;

    expect(addAssistantUsage(totals, usage)).toBeUndefined();
    expect(totals.input).toBe(Number.MAX_VALUE);
  });

  it("rejects non-negative-finite context and model counts before rendering", () => {
    const invalidModel = extensionContextFixture({
      model: {
        id: "model",
        provider: "provider",
        reasoning: false,
        contextWindow: Number.POSITIVE_INFINITY,
      },
    });
    expect(materializeModel(invalidModel)).toBeUndefined();

    const invalidContext = extensionContextFixture({
      getContextUsage: () => ({ contextWindow: 100_000, tokens: -1, percent: 10 }),
    });
    expect(materializeContextUsage(invalidContext)).toBeUndefined();
  });
});
