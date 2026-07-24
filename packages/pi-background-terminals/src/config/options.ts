import type { BackgroundTerminalConfig } from "./schema.ts";
import { DEFAULT_BACKGROUND_TERMINAL_CONFIG } from "./schema.ts";

const integerIn = (value: number | undefined, fallback: number, min: number, max: number) =>
  value === undefined ? fallback : Math.min(max, Math.max(min, Math.floor(value)));

export function normalizeConfig(
  value: Partial<BackgroundTerminalConfig> = {},
): BackgroundTerminalConfig {
  const perJob = integerIn(
    value.logBufferBytesPerJob,
    DEFAULT_BACKGROUND_TERMINAL_CONFIG.logBufferBytesPerJob,
    4 * 1024,
    4 * 1024 * 1024,
  );
  return {
    enabled: value.enabled ?? DEFAULT_BACKGROUND_TERMINAL_CONFIG.enabled,
    maxRunning: integerIn(value.maxRunning, DEFAULT_BACKGROUND_TERMINAL_CONFIG.maxRunning, 1, 64),
    maxRetained: integerIn(
      value.maxRetained,
      DEFAULT_BACKGROUND_TERMINAL_CONFIG.maxRetained,
      1,
      500,
    ),
    logBufferBytesPerJob: perJob,
    totalLogBufferBytes: Math.max(
      perJob,
      integerIn(
        value.totalLogBufferBytes,
        DEFAULT_BACKGROUND_TERMINAL_CONFIG.totalLogBufferBytes,
        4 * 1024,
        32 * 1024 * 1024,
      ),
    ),
    stopGraceMs: integerIn(
      value.stopGraceMs,
      DEFAULT_BACKGROUND_TERMINAL_CONFIG.stopGraceMs,
      0,
      30_000,
    ),
    maxLogWaitSeconds: integerIn(
      value.maxLogWaitSeconds,
      DEFAULT_BACKGROUND_TERMINAL_CONFIG.maxLogWaitSeconds,
      0,
      120,
    ),
    showFooterStatus: value.showFooterStatus ?? DEFAULT_BACKGROUND_TERMINAL_CONFIG.showFooterStatus,
    ...(value.shellPath?.trim() ? { shellPath: value.shellPath.trim() } : {}),
  };
}
