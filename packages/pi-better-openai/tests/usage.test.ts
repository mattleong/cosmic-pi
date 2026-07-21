// @effect-diagnostics effect/globalDate:off
// @effect-diagnostics effect/processEnv:off
import { describe, expect, test } from "vitest";
import { maskIdentifier, sanitizeDiagnosticError } from "pi-cosmic-core";
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
  test("masks and sanitizes diagnostic identifiers", () => {
    expect(maskIdentifier("acct_1234567890abcdef")).toBe("acct...cdef");
    const sanitized = sanitizeDiagnosticError(
      `\u001b[31mAuthorization: Bearer sk-secretsecret accountId=acct_1234567890abcdef ${"x".repeat(700)}`,
    );
    expect(sanitized).not.toContain("\u001b");
    expect(sanitized).not.toContain("sk-secretsecret");
    expect(sanitized).not.toContain("acct_1234567890abcdef");
    expect(sanitized.length).toBeLessThanOrEqual(500);
  });

  test.each([
    [99.4, "99%"],
    [0, "0%"],
    [null, "--"],
  ])("formats percentage %s", (value, expected) => {
    expect(_test.formatPercent(value)).toBe(expected);
  });

  test("parses and formats standard usage", () => {
    const usage = _test.parseUsageSnapshot(payload(), "gpt-5.5", NOW);
    expect(usage).toMatchObject({
      fiveHourLeftPercent: 90,
      sevenDayLeftPercent: 80,
      isLimited: false,
    });
    expect(_test.formatUsageSnapshot(usage, { showResetTimes: false }, NOW)).toBe(
      "Usage: 5h: 90% | 7d: 80%",
    );
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

  test("falls back to base rate limit for Spark", () => {
    const usage = _test.parseUsageSnapshot(payload(), "gpt-5.3-codex-spark", NOW);
    expect(usage.scope).toBe("spark");
    expect(usage.fiveHourLeftPercent).toBe(90);
    expect(usage.sevenDayLeftPercent).toBe(80);
  });

  test("uses Spark-specific additional limits when present", () => {
    const usage = _test.parseUsageSnapshot(
      {
        ...payload(),
        additional_rate_limits: [
          {
            limit_name: "GPT-5.3-Codex-Spark",
            rate_limit: { primary_window: { used_percent: 40, reset_after_seconds: 100 } },
          },
        ],
      },
      "gpt-5.3-codex-spark",
      NOW,
    );
    expect(usage.sevenDayLeftPercent).toBe(60);
  });
});
