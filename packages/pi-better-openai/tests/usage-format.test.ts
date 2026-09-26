import { describe, expect, it } from "vitest";
import { parseUsageSnapshot, type CodexUsageResponse } from "../src/usage/format.ts";

const NOW = 1_700_000_000_000;

describe("OpenAI usage parsing", () => {
  it("projects an already decoded primary bucket", () => {
    const response: CodexUsageResponse = {
      rate_limit: {
        allowed: true,
        primary_window: { used_percent: 25, reset_after_seconds: 300 },
        secondary_window: { used_percent: 40, reset_after_seconds: 600 },
      },
    };

    expect(parseUsageSnapshot(response, "gpt-5.5", NOW)).toEqual({
      capturedAt: NOW,
      scope: "default",
      fiveHourLeftPercent: 75,
      sevenDayLeftPercent: 60,
      fiveHourResetInSeconds: 300,
      sevenDayResetInSeconds: 600,
      isLimited: false,
    });
  });

  it("decodes unknown additional entries before selecting the Spark bucket", () => {
    const response: CodexUsageResponse = {
      rate_limit: {
        primary_window: { used_percent: 90 },
        secondary_window: { used_percent: 95 },
      },
      additional_rate_limits: [
        {
          limit_name: "GPT-5.3-Codex-Spark",
          rate_limit: { primary_window: { used_percent: "invalid" } },
        },
        {
          limit_name: "GPT-5.3-Codex-Spark",
          rate_limit: {
            primary_window: { used_percent: 15 },
            secondary_window: { used_percent: 35 },
            limit_reached: true,
          },
        },
      ],
    };

    expect(parseUsageSnapshot(response, "gpt-5.3-codex-spark", NOW)).toMatchObject({
      scope: "spark",
      fiveHourLeftPercent: 85,
      sevenDayLeftPercent: 65,
      isLimited: true,
    });
  });

  it("falls back to the decoded primary bucket when no Spark entry is usable", () => {
    const response: CodexUsageResponse = {
      rate_limit: {
        allowed: false,
        primary_window: { used_percent: 30 },
      },
      additional_rate_limits: {
        malformed: {
          limit_name: "GPT-5.3-Codex-Spark",
          rate_limit: { primary_window: { used_percent: "invalid" } },
        },
      },
    };

    expect(parseUsageSnapshot(response, "gpt-5.3-codex-spark", NOW)).toMatchObject({
      scope: "spark",
      fiveHourLeftPercent: null,
      sevenDayLeftPercent: 70,
      isLimited: true,
    });
  });
});
