import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import { settingOnOff } from "pi-cosmic-ui/manager/settings-surface";
import { completeSettingsArguments } from "pi-cosmic-core/settings-completion";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { BACKGROUND_TASK_SETTINGS } from "../config/options.ts";
import type { BackgroundTaskConfig, BackgroundTaskSettingId } from "../config/schema.ts";

export const SCOPES = [
  { name: "global", description: "Change a setting everywhere" },
  { name: "project", description: "Change a setting for this trusted project" },
] as const;

export const INHERIT = "inherit";

/** A stored or effective value as settings show it: booleans read `on`/`off`. */
export const settingDisplayValue = (value: BackgroundTaskConfig[BackgroundTaskSettingId]) =>
  Predicate.isBoolean(value) ? settingOnOff(value) : sanitizeTerminalLine(String(value ?? ""));

export const sessionValue = (config: BackgroundTaskConfig, id: BackgroundTaskSettingId) =>
  settingDisplayValue(config[id]);

/** `inherit (on)` and other inherited labels mean `inherit` when chosen. */
export const inheritChoice = (value: string): string =>
  value === INHERIT || (Str.startsWith(`${INHERIT} (`)(value) && Str.endsWith(")")(value))
    ? INHERIT
    : value;

export const TASK_SETTING_DESCRIPTORS = Arr.map(BACKGROUND_TASK_SETTINGS, (setting) => ({
  id: setting.id,
  description: setting.description,
  ...(setting.values.length > 0 && { values: [...setting.values, INHERIT] }),
  openValues: setting.openValues,
  currentValue: (config: BackgroundTaskConfig) => sessionValue(config, setting.id),
}));

export const TASK_SETTINGS_COMMAND = {
  name: "settings",
  description: "Configure background tasks",
  complete: (prefix: string) =>
    completeSettingsArguments(
      prefix,
      TASK_SETTING_DESCRIPTORS,
      [
        { value: "status", label: "status", description: "Show effective values" },
        { value: "help", label: "help", description: "Show setting ids and usage" },
      ],
      Arr.map(SCOPES, (scope) => ({
        value: scope.name,
        label: scope.name,
        description: scope.description,
      })),
    ),
};
