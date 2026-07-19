import { describe, expect, test, vi } from "vitest";
import {
  formatUsageSnapshot,
  parseMonthlyBilling,
  parseUsageSnapshot,
  parseWeeklyBilling,
  requestXaiUsage,
} from "../src/usage.ts";

const monthlyFixture = {
  config: {
    monthlyLimit: { val: 15000 },
    used: { val: 2524 },
    onDemandCap: { val: 0 },
    billingPeriodStart: "2026-07-01T00:00:00+00:00",
    billingPeriodEnd: "2026-08-01T00:00:00+00:00",
  },
};

const weeklyFixture = {
  config: {
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-07-13T18:37:17.787360+00:00",
      end: "2026-07-20T18:37:17.787360+00:00",
    },
    creditUsagePercent: 18.0,
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    billingPeriodStart: "2026-07-13T18:37:17.787360+00:00",
    billingPeriodEnd: "2026-07-20T18:37:17.787360+00:00",
  },
};

describe("xAI usage parsing", () => {
  test("parses monthly and weekly billing into left-percent windows", () => {
    const now = Date.parse("2026-07-19T00:00:00.000Z");
    const snapshot = parseUsageSnapshot(monthlyFixture, weeklyFixture, now);

    expect(snapshot.weeklyUsedPercent).toBe(18);
    expect(snapshot.weeklyLeftPercent).toBe(82);
    expect(snapshot.monthlyUsed).toBe(2524);
    expect(snapshot.monthlyLimit).toBe(15000);
    expect(snapshot.monthlyUsedPercent).toBeCloseTo(16.8266, 3);
    expect(snapshot.monthlyLeftPercent).toBeCloseTo(83.1733, 3);
    expect(snapshot.weeklyResetInSeconds).toBeGreaterThan(0);
    expect(snapshot.monthlyResetInSeconds).toBeGreaterThan(0);
    expect(snapshot.isLimited).toBe(false);
  });

  test("defaults missing weekly percent to 0% used", () => {
    const weekly = parseWeeklyBilling({
      config: {
        billingPeriodEnd: "2026-07-20T18:37:17.787360+00:00",
      },
    });
    expect(weekly.weeklyUsedPercent).toBe(0);
    expect(weekly.weeklyLeftPercent).toBe(100);
  });

  test("keeps monthly-only snapshot when weekly payload is absent", () => {
    const monthly = parseMonthlyBilling(monthlyFixture);
    const snapshot = parseUsageSnapshot(monthlyFixture, null);
    expect(snapshot.monthlyUsed).toBe(monthly.monthlyUsed);
    expect(snapshot.weeklyLeftPercent).toBeNull();
    expect(snapshot.weeklyUsedPercent).toBeNull();
  });

  test("formats OpenAI-compatible usage text for progress bars", () => {
    const now = Date.parse("2026-07-19T00:00:00.000Z");
    const snapshot = parseUsageSnapshot(monthlyFixture, weeklyFixture, now);
    const text = formatUsageSnapshot(snapshot, { showResetTimes: false }, now);
    expect(text).toMatch(/^Usage: 7d: 82% \| mo: 83%$/);
  });

  test("includes reset suffixes when enabled", () => {
    const now = Date.parse("2026-07-19T00:00:00.000Z");
    const snapshot = parseUsageSnapshot(monthlyFixture, weeklyFixture, now);
    const text = formatUsageSnapshot(snapshot, { showResetTimes: true }, now);
    expect(text).toContain("7d: 82%");
    expect(text).toContain("mo: 83%");
    expect(text).toContain("7d ↺");
    expect(text).toContain("mo ↺");
  });

  test("marks exhausted windows as limited", () => {
    const snapshot = parseUsageSnapshot(
      {
        config: {
          monthlyLimit: { val: 100 },
          used: { val: 100 },
          billingPeriodEnd: "2026-08-01T00:00:00+00:00",
        },
      },
      {
        config: {
          creditUsagePercent: 100,
          billingPeriodEnd: "2026-07-20T18:37:17.787360+00:00",
        },
      },
    );
    expect(snapshot.isLimited).toBe(true);
    expect(snapshot.weeklyLeftPercent).toBe(0);
    expect(snapshot.monthlyLeftPercent).toBe(0);
  });
});

describe("requestXaiUsage", () => {
  test("parses parallel billing responses", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("format=credits")) {
        return new Response(JSON.stringify(weeklyFixture), { status: 200 });
      }
      return new Response(JSON.stringify(monthlyFixture), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const snapshot = await requestXaiUsage({
        modelRegistry: {
          getApiKeyForProvider: async () => "test-token",
        },
      } as never);

      expect(snapshot?.weeklyLeftPercent).toBe(82);
      expect(snapshot?.monthlyUsed).toBe(2524);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
