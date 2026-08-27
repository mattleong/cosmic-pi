import type { BackgroundTaskConfig } from "./schema.ts";
import { DEFAULT_BACKGROUND_TASK_CONFIG } from "./schema.ts";

const integerIn = (value: number | undefined, fallback: number, min: number, max: number) =>
  value === undefined ? fallback : Math.min(max, Math.max(min, Math.floor(value)));

export function normalizeConfig(value: Partial<BackgroundTaskConfig> = {}): BackgroundTaskConfig {
  const perTask = integerIn(
    value.logBufferBytesPerTask,
    DEFAULT_BACKGROUND_TASK_CONFIG.logBufferBytesPerTask,
    4 * 1024,
    4 * 1024 * 1024,
  );
  const normalizedConfig = {
    enabled: value.enabled ?? DEFAULT_BACKGROUND_TASK_CONFIG.enabled,
    maxRunning: integerIn(value.maxRunning, DEFAULT_BACKGROUND_TASK_CONFIG.maxRunning, 1, 64),
    maxRetained: integerIn(value.maxRetained, DEFAULT_BACKGROUND_TASK_CONFIG.maxRetained, 1, 500),
    logBufferBytesPerTask: perTask,
    totalLogBufferBytes: Math.max(
      perTask,
      integerIn(
        value.totalLogBufferBytes,
        DEFAULT_BACKGROUND_TASK_CONFIG.totalLogBufferBytes,
        4 * 1024,
        32 * 1024 * 1024,
      ),
    ),
    stopGraceMs: integerIn(
      value.stopGraceMs,
      DEFAULT_BACKGROUND_TASK_CONFIG.stopGraceMs,
      0,
      30_000,
    ),
    maxLogWaitSeconds: integerIn(
      value.maxLogWaitSeconds,
      DEFAULT_BACKGROUND_TASK_CONFIG.maxLogWaitSeconds,
      0,
      120,
    ),
    showFooterStatus: value.showFooterStatus ?? DEFAULT_BACKGROUND_TASK_CONFIG.showFooterStatus,
  };
  const shellPath = value.shellPath?.trim();
  return shellPath ? { ...normalizedConfig, shellPath } : normalizedConfig;
}
