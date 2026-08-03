import { describe, expect, test } from "vitest";
import {
  DEFAULT_ADVISOR_CONFIG,
  normalizeAdvisorConfig,
  patchAdvisorConfig,
} from "../src/config/options.ts";

describe("Advisor config", () => {
  test("defaults to disabled with setup available", () => {
    const config = normalizeAdvisorConfig({}, "/config.json");
    expect(config).toEqual({
      configPath: "/config.json",
      enabled: false,
      setupDismissed: false,
      configured: false,
    });
    expect(DEFAULT_ADVISOR_CONFIG).toEqual({
      enabled: false,
      setupDismissed: false,
    });
  });

  test("decodes only the approved persisted fields", () => {
    const config = normalizeAdvisorConfig(
      {
        enabled: true,
        provider: " provider ",
        model: " model ",
        setupDismissed: true,
      },
      "/config.json",
    );
    expect(config).toEqual({
      configPath: "/config.json",
      enabled: true,
      provider: "provider",
      model: "model",
      setupDismissed: true,
      configured: true,
    });
  });

  test("ignores fields outside the strict persisted contract", () => {
    const config = normalizeAdvisorConfig(
      {
        enabled: true,
        mode: "coach",
        futureRuntimeOptions: { experimental: true },
      },
      "/config.json",
    );
    expect(config).toEqual({
      configPath: "/config.json",
      enabled: true,
      setupDismissed: false,
      configured: false,
    });
  });

  test("recovers invalid fields independently", () => {
    expect(
      normalizeAdvisorConfig(
        { enabled: "yes", provider: "p", model: "m", setupDismissed: 1 },
        "/config.json",
      ),
    ).toEqual({
      configPath: "/config.json",
      enabled: false,
      provider: "p",
      model: "m",
      setupDismissed: false,
      configured: true,
    });
  });

  test("patches current fields, scrubs removed fields, and preserves unrelated data", () => {
    expect(
      patchAdvisorConfig(
        {
          future: { keep: true },
          mode: "review",
          reviewPolicy: "advisory",
          fastMode: true,
          thinkingLevel: "high",
          timeoutMs: 1,
          maxContextChars: 2,
        },
        {
          enabled: true,
          provider: "p",
          model: "m",
          setupDismissed: true,
        },
      ),
    ).toEqual({
      future: { keep: true },
      enabled: true,
      provider: "p",
      model: "m",
      setupDismissed: true,
    });
  });

  test("clearing model fields removes them", () => {
    expect(
      patchAdvisorConfig(
        { provider: "p", model: "m", enabled: true },
        {
          provider: undefined,
          model: undefined,
          enabled: false,
        },
      ),
    ).toEqual({ enabled: false });
  });
});
