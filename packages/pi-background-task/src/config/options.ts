import type { BackgroundTaskConfig } from "./schema.ts";
import { DEFAULT_BACKGROUND_TASK_CONFIG } from "./schema.ts";

/** Whole-number ranges that both normalization and the `/tasks settings` parsers enforce. */
const NUMBER_BOUNDS = {
  maxRunning: { minimum: 1, maximum: 64 },
  maxRetained: { minimum: 1, maximum: 500 },
  logBufferBytesPerTask: { minimum: 4 * 1024, maximum: 4 * 1024 * 1024 },
  totalLogBufferBytes: { minimum: 4 * 1024, maximum: 32 * 1024 * 1024 },
  stopGraceMs: { minimum: 0, maximum: 30_000 },
  maxWaitSeconds: { minimum: 0, maximum: 120 },
} as const;
type NumberSetting = keyof typeof NUMBER_BOUNDS;

export function normalizeConfig(value: Partial<BackgroundTaskConfig> = {}): BackgroundTaskConfig {
  const bounded = (id: NumberSetting) => {
    const { minimum, maximum } = NUMBER_BOUNDS[id];
    const configured = value[id];
    return configured === undefined
      ? DEFAULT_BACKGROUND_TASK_CONFIG[id]
      : Math.min(maximum, Math.max(minimum, Math.floor(configured)));
  };
  const perTask = bounded("logBufferBytesPerTask");
  const normalizedConfig = {
    enabled: value.enabled ?? DEFAULT_BACKGROUND_TASK_CONFIG.enabled,
    maxRunning: bounded("maxRunning"),
    maxRetained: bounded("maxRetained"),
    logBufferBytesPerTask: perTask,
    totalLogBufferBytes: Math.max(perTask, bounded("totalLogBufferBytes")),
    stopGraceMs: bounded("stopGraceMs"),
    maxWaitSeconds: bounded("maxWaitSeconds"),
    showFooterStatus: value.showFooterStatus ?? DEFAULT_BACKGROUND_TASK_CONFIG.showFooterStatus,
  };
  const shellPath = value.shellPath?.trim();
  return shellPath ? { ...normalizedConfig, shellPath } : normalizedConfig;
}

/** One `/tasks settings` setting: its words, and how a typed value becomes a stored one. */
interface BackgroundTaskSettingDescriptor {
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
  id: NumberSetting,
  label: string,
  description: string,
  values: readonly string[],
) => {
  const { minimum, maximum } = NUMBER_BOUNDS[id];
  return {
    id,
    label,
    description,
    values,
    openValues: true,
    parse: (value: string) => {
      const parsed = /^(?:0|[1-9][0-9]*)$/u.test(value) ? Number(value) : Number.NaN;
      return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
        ? parsed
        : undefined;
    },
    invalid: `${id} must be a whole number from ${minimum} to ${maximum}`,
  };
};

export const BACKGROUND_TASK_SETTINGS: readonly BackgroundTaskSettingDescriptor[] = [
  onOff("enabled", "Background tasks", "Allow the agent to start background tasks."),
  wholeNumber("maxRunning", "Running at once", "How many tasks may run at the same time.", [
    "4",
    "8",
    "16",
    "32",
  ]),
  wholeNumber("maxRetained", "Tasks kept", "How many finished tasks stay listed.", [
    "20",
    "50",
    "100",
    "200",
  ]),
  wholeNumber(
    "logBufferBytesPerTask",
    "Output kept per task (bytes)",
    "How much recent output each task keeps.",
    ["65536", "262144", "1048576"],
  ),
  wholeNumber(
    "totalLogBufferBytes",
    "Output kept in total (bytes)",
    "How much output all tasks keep together.",
    ["1048576", "2097152", "8388608"],
  ),
  wholeNumber(
    "stopGraceMs",
    "Stop grace (ms)",
    "How long a stopping task gets before it is killed.",
    ["0", "2000", "5000", "10000"],
  ),
  wholeNumber(
    "maxWaitSeconds",
    "Longest wait (seconds)",
    "The longest the agent may wait on a task at once.",
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
