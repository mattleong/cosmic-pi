import { describe, expect, it } from "vitest";
import { formatCost, formatUsage } from "../src/ui/metrics.ts";
import { aggregateRunUsage } from "../src/tools/render-run-rows.ts";
import type { SubagentRunCard } from "../src/tools/details.ts";

const card = (usage?: SubagentRunCard["usage"]): SubagentRunCard =>
  (() => {
    const objectPart314_0 = {
      id: "agent-1",
      name: "worker",
      state: "completed" as const,
      reportGeneration: 1,
      model: "provider/model",
      effort: "high" as const,
      selection: { source: "profile-candidate" as const, reason: "Route.", skippedCandidates: [] },
    };
    const objectPart314_1 = usage ? { ...objectPart314_0, usage } : objectPart314_0;
    return objectPart314_1;
  })();

describe("usage metrics formatting", () => {
  it("trims trailing zeros from sub-cent prices", () => {
    expect(formatCost(0.001)).toBe("$0.001");
    expect(formatCost(0.0001)).toBe("$0.0001");
    expect(formatCost(0.00001)).toBe("$<0.0001");
    expect(formatCost(0.0012)).toBe("$0.0012");
    expect(formatCost(0.0123)).toBe("$0.01");
    expect(formatCost(1.5)).toBe("$1.50");
    expect(formatCost(0)).toBe("$0");
  });

  it("omits unknown cost and renders nothing for unknown usage", () => {
    expect(formatUsage(undefined)).toBe("");
    expect(formatUsage({ totalTokens: 0 })).toBe("");
    expect(formatUsage({ totalTokens: 0, cost: 0 })).toBe("");
    expect(formatUsage({ totalTokens: 1_500 })).toBe("1.5k tokens");
    expect(formatUsage({ totalTokens: 1_500, cost: 0 })).toBe("1.5k tokens · $0");
    expect(formatUsage({ totalTokens: 10, cost: 0.001 }, "tok")).toBe("10 tok · $0.001");
  });

  it("marks fleet cost subtotals over unknown-cost runs as a lower bound", () => {
    const known = card({
      input: 5,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 10,
      cost: 0.5,
    });
    const unknown = card({ input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5 });
    expect(aggregateRunUsage([known, unknown])).toBe("15 tokens · ≥ $0.50");
    expect(aggregateRunUsage([known, { ...known }])).toBe("20 tokens · $1.00");
    expect(aggregateRunUsage([unknown])).toBe("5 tokens");
    expect(aggregateRunUsage([card()])).toBe("");
  });
});
