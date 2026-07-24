// @effect-diagnostics effect/globalDate:off
// @effect-diagnostics effect/processEnv:off
import { describe, expect, test } from "vitest";
import { _test } from "../index.ts";

const NOW = 1_752_883_200_000;
const payload = () => ({
  rate_limit: {
    allowed: true,
    primary_window: { used_percent: 10, reset_after_seconds: 60 },
    secondary_window: { used_percent: 20, reset_after_seconds: 3600 },
  },
});

describe("usage helpers", () => {
  test.each([
    [99.4, "99%"],
    [0, "0%"],
    [null, "--"],
  ])("formats percentage %s", (value, expected) => {
    expect(_test.formatPercent(value)).toBe(expected);
  });

  test("treats a lone primary window as weekly-only", () => {
    const usage = _test.parseUsageSnapshot(
      {
        rate_limit: {
          primary_window: { used_percent: 30, reset_after_seconds: 6 * 86_400 },
          secondary_window: null,
        },
      },
      "gpt-5.5",
      NOW,
    );
    expect(usage.fiveHourLeftPercent).toBeNull();
    expect(usage.sevenDayLeftPercent).toBe(70);
    expect(_test.formatUsageSnapshot(usage, { showResetTimes: true }, NOW)).toContain("7d ↺ 6d0h");
  });

  test("decrements reset countdown without moving the reset clock", () => {
    const usage = _test.parseUsageSnapshot(
      { rate_limit: { primary_window: { used_percent: 10, reset_after_seconds: 3600 } } },
      "gpt-5.5",
      NOW,
    );
    const initial = _test.formatUsageSnapshot(usage, { showResetTimes: true }, NOW);
    const later = _test.formatUsageSnapshot(usage, { showResetTimes: true }, NOW + 30 * 60_000);
    const expired = _test.formatUsageSnapshot(usage, { showResetTimes: true }, NOW + 90 * 60_000);
    expect(initial).toContain("7d ↺ 1h0m");
    expect(later).toContain("7d ↺ 30m");
    expect(expired).toContain("7d ↺ 0s");
  });

  test.each([
    ["relative", { reset_after_seconds: 1e300 }],
    ["absolute", { reset_at: 1e300 }],
  ])("rejects an out-of-range %s reset without discarding usage", (_kind, reset) => {
    const usage = _test.parseUsageSnapshot(
      { rate_limit: { primary_window: { used_percent: 10, ...reset } } },
      "gpt-5.5",
      NOW,
    );

    expect(usage.sevenDayLeftPercent).toBe(90);
    expect(usage.sevenDayResetInSeconds).toBeNull();
    expect(_test.formatUsageSnapshot(usage, { showResetTimes: true }, NOW)).toBe("Usage: 7d: 90%");
  });

  test("falls back to base rate limit for Spark", () => {
    const usage = _test.parseUsageSnapshot(payload(), "gpt-5.3-codex-spark", NOW);
    expect(usage.scope).toBe("spark");
    expect(usage.fiveHourLeftPercent).toBe(90);
    expect(usage.sevenDayLeftPercent).toBe(80);
  });
});
