import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { formatBytes, formatDuration } from "pi-cosmic-core/display";
import { formatDisplayPath } from "pi-cosmic-core/platform/paths";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { ON_OFF_SETTING_VALUES, settingOnOff } from "pi-cosmic-ui/manager/settings-surface";
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
  const shellPath = value.shellPath && Str.trim(value.shellPath);
  return shellPath ? { ...normalizedConfig, shellPath } : normalizedConfig;
}

/** How a setting's value reads: counts as numbers, sizes and durations in their units. */
export type BackgroundTaskSettingKind =
  | "switch"
  | "count"
  | "bytes"
  | "milliseconds"
  | "seconds"
  | "path";

export interface BackgroundTaskSettingDescriptor<Id extends BackgroundTaskSettingId> {
  readonly id: Id;
  readonly label: string;
  readonly description: string;
  readonly kind: BackgroundTaskSettingKind;
  /** Values the settings list offers, as they read there. */
  readonly values: readonly string[];
  /** The same values as one-word command arguments, such as `256KB` for `256 KB`. */
  readonly commandValues: readonly string[];
  readonly openValues: boolean;
  readonly parse: (value: string) => BackgroundTaskSettingValue<Id> | undefined;
  readonly invalid: string;
}

const NUMBER_FORMATS = {
  count: String,
  bytes: formatBytes,
  milliseconds: formatDuration,
  seconds: (seconds: number) => formatDuration(seconds * 1_000),
} as const;

/**
 * A value as settings show it: switches read `on`/`off`, sizes and durations in their units, and
 * paths home-relative.
 */
export const formatSettingValue = (
  kind: BackgroundTaskSettingKind,
  value: BackgroundTaskConfig[BackgroundTaskSettingId],
): string => {
  if (Predicate.isBoolean(value)) return settingOnOff(value);
  if (Predicate.isNumber(value))
    return kind === "switch" || kind === "path" ? String(value) : NUMBER_FORMATS[kind](value);
  return sanitizeTerminalLine(formatDisplayPath(value ?? "", ""));
};

const onOff = <Id extends BooleanSettingId>(id: Id, label: string, description: string) => ({
  id,
  label,
  description,
  kind: "switch" as const,
  values: ON_OFF_SETTING_VALUES,
  commandValues: ON_OFF_SETTING_VALUES,
  openValues: false,
  parse: (value: string): boolean | undefined =>
    Match.value(Str.toLowerCase(Str.trim(value))).pipe(
      Match.whenOr("on", "true", () => true),
      Match.whenOr("off", "false", () => false),
      Match.orElse(() => undefined),
    ),
  invalid: `${id} must be on or off`,
});

const WHOLE_NUMBER = /^(?:0|[1-9][0-9]*)$/u;
const parseWholeNumber = (value: string): number =>
  WHOLE_NUMBER.test(Str.trim(value)) ? Number(Str.trim(value)) : Number.NaN;

const BYTE_SIZE = /^(\d+(?:\.\d+)?)\s*(?:([km])(?:i?b)?|b)?$/u;
const UNIT_BYTES = { k: 1024, m: 1024 ** 2 } as const;

/** A byte count such as `262144`, `256k`, `256 KB`, `256 KiB`, or `1.5MB`; units are binary. */
export const parseByteSize = (value: string): number => {
  const match = BYTE_SIZE.exec(Str.toLowerCase(Str.trim(value)));
  if (!match) return Number.NaN;
  const [, amount = "", unit] = match;
  const bytes = Number(amount) * (unit === "k" || unit === "m" ? UNIT_BYTES[unit] : 1);
  return Number.isInteger(bytes) ? bytes : Number.NaN;
};

const DURATION_PART = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)/gu;
const DURATION = /^(?:\d+(?:\.\d+)?\s*(?:ms|s|m|h)\s*)+$/u;
const UNIT_MILLISECONDS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;

/**
 * A duration in whole `unit` milliseconds: a bare number counts in that unit, and units read as
 * settings show them, such as `2s`, `500ms`, `1m 30s`, or `1h`.
 */
export const parseDuration = (value: string, unit: number): number => {
  const text = Str.toLowerCase(Str.trim(value));
  if (WHOLE_NUMBER.test(text)) return Number(text);
  if (!DURATION.test(text)) return Number.NaN;
  let milliseconds = 0;
  for (const [, amount = "", part = ""] of Str.matchAll(DURATION_PART)(text))
    milliseconds +=
      Number(amount) *
      (part === "ms" || part === "s" || part === "m" || part === "h"
        ? UNIT_MILLISECONDS[part]
        : Number.NaN);
  const whole = Math.round(milliseconds);
  return Math.abs(whole - milliseconds) < 1e-6 && whole % unit === 0 ? whole / unit : Number.NaN;
};

/** A one-word command argument for a preset, which reads back to the same value. */
const commandValue = (kind: BackgroundTaskSettingKind, value: number): string => {
  if (kind === "bytes")
    return value % 1024 ** 2 === 0 ? `${value / 1024 ** 2}MB` : `${value / 1024}KB`;
  return Str.replaceAll(" ", "")(formatSettingValue(kind, value));
};

const NUMBER_INPUT = {
  count: { parse: parseWholeNumber, expected: "a whole number" },
  bytes: { parse: parseByteSize, expected: "a size such as 256KB or 1MB," },
  milliseconds: {
    parse: (value: string) => parseDuration(value, 1),
    expected: "a duration such as 500ms or 2s,",
  },
  seconds: {
    parse: (value: string) => parseDuration(value, 1_000),
    expected: "a duration in whole seconds such as 30s or 5m,",
  },
} as const;

const numberSetting = <Id extends NumberSettingId>(
  id: Id,
  kind: keyof typeof NUMBER_INPUT,
  label: string,
  description: string,
  presets: readonly number[],
) => {
  const { minimum, maximum } = NUMBER_BOUNDS[id];
  const { parse, expected } = NUMBER_INPUT[kind];
  // The range reads in the same spelling as the examples before it, such as `4KB`.
  const bound = (value: number) =>
    kind === "bytes" ? commandValue(kind, value) : formatSettingValue(kind, value);
  return {
    id,
    label,
    description,
    kind,
    values: Arr.map(presets, (preset) => formatSettingValue(kind, preset)),
    commandValues: Arr.map(presets, (preset) => commandValue(kind, preset)),
    openValues: true,
    parse: (value: string): number | undefined => {
      const parsed = parse(value);
      return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
        ? parsed
        : undefined;
    },
    invalid: `${id} must be ${expected} from ${bound(minimum)} to ${bound(maximum)}`,
  };
};

/** One descriptor per config field, with its parsed value typed by that field. */
export type BackgroundTaskSetting = {
  readonly [Id in BackgroundTaskSettingId]: BackgroundTaskSettingDescriptor<Id>;
}[BackgroundTaskSettingId];

// Keyed by every config field, so adding a field without a descriptor fails to compile.
const SETTING_DESCRIPTORS = {
  enabled: onOff("enabled", "Background tasks", "Allow the agent to start background tasks."),
  maxRunning: numberSetting(
    "maxRunning",
    "count",
    "Running at once",
    "How many tasks may run at the same time.",
    [4, 8, 16, 32],
  ),
  maxRetained: numberSetting(
    "maxRetained",
    "count",
    "Tasks kept",
    "How many finished tasks stay listed.",
    [20, 50, 100, 200],
  ),
  logBufferBytesPerTask: numberSetting(
    "logBufferBytesPerTask",
    "bytes",
    "Output per task",
    "How much recent output each task keeps, counting a small overhead per stored chunk.",
    [64 * 1024, 256 * 1024, 1024 ** 2],
  ),
  totalLogBufferBytes: numberSetting(
    "totalLogBufferBytes",
    "bytes",
    "Output in total",
    "How much output all tasks keep together; at least the per-task amount.",
    [1024 ** 2, 2 * 1024 ** 2, 8 * 1024 ** 2],
  ),
  stopGraceMs: numberSetting(
    "stopGraceMs",
    "milliseconds",
    "Stop grace",
    "How long a stopping task gets before it is killed.",
    [0, 2_000, 5_000, 10_000],
  ),
  maxWaitSeconds: numberSetting(
    "maxWaitSeconds",
    "seconds",
    "Longest wait",
    "The longest the agent may wait on a task at once.",
    [10, 30, 60, 300],
  ),
  showFooterStatus: onOff(
    "showFooterStatus",
    "Footer status",
    "Show running tasks in the footer when Activity isn't listing them.",
  ),
  shellPath: {
    id: "shellPath",
    label: "Shell",
    description:
      "The shell tasks run in, instead of Pi's shell and command prefix; default uses Pi's.",
    kind: "path",
    values: [],
    commandValues: [],
    openValues: true,
    parse: (value) => Str.trim(value),
    invalid: "shellPath must be a path",
  },
} satisfies { readonly [Id in BackgroundTaskSettingId]: BackgroundTaskSettingDescriptor<Id> };

export const BACKGROUND_TASK_SETTINGS: readonly BackgroundTaskSetting[] =
  Rec.values(SETTING_DESCRIPTORS);
