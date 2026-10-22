import * as Match from "effect/Match";
import { BACKGROUND_TASK_FIELD_BOUNDS } from "../task/bounds.ts";
import type {
  BackgroundTaskConfig,
  BackgroundTaskSettingId,
  BackgroundTaskSettingValue,
} from "./schema.ts";
import { DEFAULT_BACKGROUND_TASK_CONFIG } from "./schema.ts";

type SettingIdOf<Value> = {
  readonly [Id in BackgroundTaskSettingId]: BackgroundTaskSettingValue<Id> extends Value
    ? Id
    : never;
}[BackgroundTaskSettingId];
type NumberSettingId = SettingIdOf<number>;
type BooleanSettingId = SettingIdOf<boolean>;

const NUMBER_BOUNDS = {
  maxRunning: { minimum: 1, maximum: 64 },
  maxRetained: { minimum: 1, maximum: 500 },
  logBufferBytesPerTask: { minimum: 4 * 1024, maximum: 4 * 1024 * 1024 },
  totalLogBufferBytes: { minimum: 4 * 1024, maximum: 32 * 1024 * 1024 },
  stopGraceMs: { minimum: 0, maximum: 30_000 },
  // The tool and result schemas share this cap, so a configured wait always decodes.
  maxWaitSeconds: { minimum: 0, maximum: BACKGROUND_TASK_FIELD_BOUNDS.maxWaitSeconds },
} satisfies {
  readonly [Id in NumberSettingId]: { readonly minimum: number; readonly maximum: number };
};

export function normalizeConfig(value: Partial<BackgroundTaskConfig> = {}): BackgroundTaskConfig {
  const bounded = (id: NumberSettingId) => {
    const { minimum, maximum } = NUMBER_BOUNDS[id];
    const configured = value[id];
    return configured === undefined
      ? DEFAULT_BACKGROUND_TASK_CONFIG[id]
      : Math.min(maximum, Math.max(minimum, Math.floor(configured)));
  };
  const perTask = bounded("logBufferBytesPerTask");
  const normalizedConfig: BackgroundTaskConfig = {
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

export interface BackgroundTaskSettingDescriptor<Id extends BackgroundTaskSettingId> {
  readonly id: Id;
  readonly label: string;
  readonly description: string;
  readonly values: readonly string[];
  readonly openValues: boolean;
  readonly parse: (value: string) => BackgroundTaskSettingValue<Id> | undefined;
  readonly invalid: string;
}

const onOff = <Id extends BooleanSettingId>(id: Id, label: string, description: string) => ({
  id,
  label,
  description,
  values: ["true", "false"],
  openValues: false,
  parse: (value: string): boolean | undefined =>
    Match.value(value).pipe(
      Match.when("true", () => true),
      Match.when("false", () => false),
      Match.orElse(() => undefined),
    ),
  invalid: `${id} must be true or false`,
});

const wholeNumber = <Id extends NumberSettingId>(
  id: Id,
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
    parse: (value: string): number | undefined => {
      const parsed = /^(?:0|[1-9][0-9]*)$/u.test(value) ? Number(value) : Number.NaN;
      return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
        ? parsed
        : undefined;
    },
    invalid: `${id} must be a whole number from ${minimum} to ${maximum}`,
  };
};

/** One descriptor per config field, with its parsed value typed by that field. */
export type BackgroundTaskSetting = {
  readonly [Id in BackgroundTaskSettingId]: BackgroundTaskSettingDescriptor<Id>;
}[BackgroundTaskSettingId];

// Keyed by every config field, so adding a field without a descriptor fails to compile.
const SETTING_DESCRIPTORS = {
  enabled: onOff("enabled", "Background tasks", "Allow the agent to start background tasks."),
  maxRunning: wholeNumber(
    "maxRunning",
    "Running at once",
    "How many tasks may run at the same time.",
    ["4", "8", "16", "32"],
  ),
  maxRetained: wholeNumber("maxRetained", "Tasks kept", "How many finished tasks stay listed.", [
    "20",
    "50",
    "100",
    "200",
  ]),
  logBufferBytesPerTask: wholeNumber(
    "logBufferBytesPerTask",
    "Output kept per task (bytes)",
    "How much recent output each task keeps, counting a small overhead per stored chunk.",
    ["65536", "262144", "1048576"],
  ),
  totalLogBufferBytes: wholeNumber(
    "totalLogBufferBytes",
    "Output kept in total (bytes)",
    "How much output all tasks keep together; at least the per-task amount.",
    ["1048576", "2097152", "8388608"],
  ),
  stopGraceMs: wholeNumber(
    "stopGraceMs",
    "Stop grace (ms)",
    "How long a stopping task gets before it is killed.",
    ["0", "2000", "5000", "10000"],
  ),
  maxWaitSeconds: wholeNumber(
    "maxWaitSeconds",
    "Longest wait (seconds)",
    "The longest the agent may wait on a task at once.",
    ["10", "30", "60", String(NUMBER_BOUNDS.maxWaitSeconds.maximum)],
  ),
  showFooterStatus: onOff("showFooterStatus", "Footer status", "Show running tasks in the footer."),
  shellPath: {
    id: "shellPath",
    label: "Shell",
    description: "The shell tasks run in; empty uses the platform default.",
    values: [],
    openValues: true,
    parse: (value) => value.trim(),
    invalid: "shellPath must be a path",
  },
} satisfies { readonly [Id in BackgroundTaskSettingId]: BackgroundTaskSettingDescriptor<Id> };

export const BACKGROUND_TASK_SETTINGS: readonly BackgroundTaskSetting[] =
  Object.values(SETTING_DESCRIPTORS);
