import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config/options.ts";
import { DEFAULT_BACKGROUND_TERMINAL_CONFIG } from "../src/config/schema.ts";

describe("background terminal config", () => {
  it("normalizes bounds and preserves independent valid fields", () => {
    const config = normalizeConfig({
      enabled: false,
      maxRunning: 0,
      maxRetained: 10_000,
      logBufferBytesPerJob: 8_192,
      totalLogBufferBytes: 1,
      stopGraceMs: -1,
      maxLogWaitSeconds: 999,
      shellPath: "  /bin/zsh  ",
    });
    expect(config.enabled).toBe(false);
    expect(config.maxRunning).toBe(1);
    expect(config.maxRetained).toBe(500);
    expect(config.totalLogBufferBytes).toBeGreaterThanOrEqual(config.logBufferBytesPerJob);
    expect(config.stopGraceMs).toBe(0);
    expect(config.maxLogWaitSeconds).toBe(120);
    expect(config.shellPath).toBe("/bin/zsh");
  });

  it("uses safe defaults", () => {
    expect(normalizeConfig()).toEqual(DEFAULT_BACKGROUND_TERMINAL_CONFIG);
  });
});
