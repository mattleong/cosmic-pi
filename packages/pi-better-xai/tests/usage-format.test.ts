import { describe, expect, it } from "vitest";
import { formatUsageDetails, type UsageSnapshot } from "../src/usage/format.ts";

const snapshotWithOnDemandUsed = (onDemandUsed: number | null): UsageSnapshot => ({
  capturedAt: 0,
  weeklyUsedPercent: null,
  weeklyLeftPercent: null,
  weeklyResetInSeconds: null,
  monthlyUsed: null,
  monthlyLimit: null,
  monthlyLeftPercent: null,
  monthlyResetInSeconds: null,
  onDemandCap: 500,
  onDemandUsed,
});

describe("xAI usage formatting", () => {
  it("distinguishes unavailable on-demand usage from a numeric zero", () => {
    const unavailable = formatUsageDetails(snapshotWithOnDemandUsed(null), 0);
    const zero = formatUsageDetails(snapshotWithOnDemandUsed(0), 0);

    expect(unavailable).toContain("  On-demand: unavailable");
    expect(unavailable).not.toContain("  On-demand: $0 / $5");
    expect(zero).toContain("  On-demand: $0 / $5");
  });
});
