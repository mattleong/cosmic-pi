import { describe, expect, it } from "vitest";
import {
  formatUsageDetails,
  formatUsageSnapshot,
  parseUsageSnapshot,
  type UsageSnapshot,
} from "../src/usage/format.ts";

describe("xAI usage parsing", () => {
  it.each([undefined, null, { config: {} }, { config: { creditUsagePercent: 0 } }])(
    "distinguishes missing weekly usage from reported zero: %j",
    (weekly) => {
      const snapshot = parseUsageSnapshot({ config: {} }, weekly, 0);
      const reported = weekly?.config.creditUsagePercent === 0;
      expect(snapshot.weeklyUsedPercent).toBe(reported ? 0 : null);
      expect(snapshot.weeklyLeftPercent).toBe(reported ? 100 : null);
      expect(snapshot.monthlyLeftPercent).toBeNull();
      expect(snapshot.onDemandUsed).toBeNull();
    },
  );

  it.each([
    [150, 100, 0],
    [25, 100, 75],
    [0, 100, 100],
    [10, 0, null],
  ] as const)("clamps monthly usage %s/%s to %s percent left", (used, limit, left) => {
    const snapshot = parseUsageSnapshot(
      { config: { used: { val: used }, monthlyLimit: { val: limit }, onDemandCap: { val: 500 } } },
      { config: { onDemandUsed: { val: 0 } } },
      123,
    );
    expect(snapshot).toMatchObject({
      capturedAt: 123,
      monthlyUsed: used,
      monthlyLimit: limit,
      monthlyLeftPercent: left,
      onDemandCap: 500,
      onDemandUsed: 0,
    });
  });

  it.each([
    [undefined, 60],
    ["", null],
    ["invalid", null],
    ["1969-12-31T23:59:00Z", 0],
    ["1970-01-01T00:02:00Z", 120],
  ] as const)("uses billing reset %s before current-period reset", (billingPeriodEnd, reset) => {
    const snapshot = parseUsageSnapshot(
      { config: { billingPeriodEnd } },
      { config: { billingPeriodEnd, currentPeriod: { end: "1970-01-01T00:01:00Z" } } },
      0,
    );
    expect(snapshot.weeklyResetInSeconds).toBe(reset);
    expect(snapshot.monthlyResetInSeconds).toBe(billingPeriodEnd === undefined ? null : reset);
  });
});

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
  it("keeps both billing windows and their short reset dates in status output", () => {
    const snapshot = parseUsageSnapshot(
      {
        config: {
          used: { val: 25 },
          monthlyLimit: { val: 100 },
          billingPeriodEnd: "1970-01-10T00:00:00Z",
        },
      },
      {
        config: {
          creditUsagePercent: 25,
          billingPeriodEnd: "1970-01-05T00:00:00Z",
        },
      },
      0,
    );
    const rendered = formatUsageSnapshot(snapshot, { showResetTimes: true }, 0);
    expect(rendered).toContain("7d: 75%");
    expect(rendered).toContain("mo: 75%");
    expect(rendered).toMatch(/\d+\/\d+ • \d+:\d{2}[ap]/);
  });

  it("distinguishes unavailable on-demand usage from a numeric zero", () => {
    const unavailable = formatUsageDetails(snapshotWithOnDemandUsed(null), 0);
    const zero = formatUsageDetails(snapshotWithOnDemandUsed(0), 0);

    expect(unavailable).toContain("  On-demand: unavailable");
    expect(unavailable).not.toContain("  On-demand: $0 / $5");
    expect(zero).toContain("  On-demand: $0 / $5");
  });
});
