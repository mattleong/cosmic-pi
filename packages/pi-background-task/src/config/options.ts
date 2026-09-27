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
    maxWaitSeconds: integerIn(
      value.maxWaitSeconds,
      DEFAULT_BACKGROUND_TASK_CONFIG.maxWaitSeconds,
      0,
      120,
    ),
    showFooterStatus: value.showFooterStatus ?? DEFAULT_BACKGROUND_TASK_CONFIG.showFooterStatus,
  };
  const shellPath = value.shellPath?.trim();
  return shellPath ? { ...normalizedConfig, shellPath } : normalizedConfig;
}

/** One `/tasks settings` setting: its words, and how a typed value becomes a stored one. */
export interface BackgroundTaskSettingDescriptor {
  readonly id: keyof BackgroundTaskConfig;
  readonly label: string;
  readonly description: string;
  readonly values: readonly string[];
  /** Other values are accepted when they parse and fall inside the bounds. */
  readonly openValues: boolean;
  readonly parse: (value: string) => boolean | number | string | undefined;
  readonly invalid: string;
}

const onOff = (id: keyof BackgroundTaskConfig, label: string, description: string) => ({
  id,
  label,
  description,
  values: ["true", "false"],
  openValues: false,
  parse: (value: string) => (value === "true" ? true : value === "false" ? false : undefined),
  invalid: `${id} must be true or false`,
});

const wholeNumber = (
  id: keyof BackgroundTaskConfig,
  label: string,
  description: string,
  bounds: { readonly minimum: number; readonly maximum: number },
  values: readonly string[],
) => ({
  id,
  label,
  description,
  values,
  openValues: true,
  parse: (value: string) => {
    const parsed = /^(?:0|[1-9][0-9]*)$/u.test(value) ? Number(value) : Number.NaN;
    return Number.isSafeInteger(parsed) && parsed >= bounds.minimum && parsed <= bounds.maximum
      ? parsed
      : undefined;
  },
  invalid: `${id} must be a whole number from ${bounds.minimum} to ${bounds.maximum}`,
});

export const BACKGROUND_TASK_SETTINGS: readonly BackgroundTaskSettingDescriptor[] = [
  onOff("enabled", "Background tasks", "Allow the agent to start background tasks."),
  wholeNumber(
    "maxRunning",
    "Running at once",
    "How many tasks may run at the same time.",
    { minimum: 1, maximum: 64 },
    ["4", "8", "16", "32"],
  ),
  wholeNumber(
    "maxRetained",
    "Tasks kept",
    "How many finished tasks stay listed.",
    { minimum: 1, maximum: 500 },
    ["20", "50", "100", "200"],
  ),
  wholeNumber(
    "logBufferBytesPerTask",
    "Output kept per task (bytes)",
    "How much recent output each task keeps.",
    { minimum: 4 * 1024, maximum: 4 * 1024 * 1024 },
    ["65536", "262144", "1048576"],
  ),
  wholeNumber(
    "totalLogBufferBytes",
    "Output kept in total (bytes)",
    "How much output all tasks keep together.",
    { minimum: 4 * 1024, maximum: 32 * 1024 * 1024 },
    ["1048576", "2097152", "8388608"],
  ),
  wholeNumber(
    "stopGraceMs",
    "Stop grace (ms)",
    "How long a stopping task gets before it is killed.",
    { minimum: 0, maximum: 30_000 },
    ["0", "2000", "5000", "10000"],
  ),
  wholeNumber(
    "maxWaitSeconds",
    "Longest wait (seconds)",
    "The longest the agent may wait on a task at once.",
    { minimum: 0, maximum: 120 },
    ["10", "30", "60", "120"],
  ),
  onOff("showFooterStatus", "Footer status", "Show running tasks in the footer."),
  {
    id: "shellPath",
    label: "Shell",
    description: "The shell tasks run in; empty uses the platform default.",
    values: [],
    openValues: true,
    parse: (value: string) => value.trim(),
    invalid: "shellPath must be a path",
  },
];

/** The value a setting shows: the configured one, or the default. */
export const backgroundTaskSettingValue = (
  config: BackgroundTaskConfig,
  id: keyof BackgroundTaskConfig,
): string => String(config[id] ?? "");
