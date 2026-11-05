import * as Arr from "effect/Array";
import { completeSettingsArguments } from "pi-cosmic-core/settings-completion";
import { isInheritedSettingValue } from "pi-cosmic-ui/manager/settings-surface";
import {
  BACKGROUND_TASK_SETTINGS,
  formatSettingValue,
  type BackgroundTaskSetting,
} from "../config/options.ts";
import type { BackgroundTaskConfig, BackgroundTaskSettingId } from "../config/schema.ts";

export const SCOPES = [
  { name: "global", description: "Every project" },
  { name: "project", description: "This trusted project" },
] as const;

export const INHERIT = "inherit";

/** A stored or effective value as settings show it, such as `on`, `256 KB`, or `2s`. */
export const settingDisplayValue = (
  setting: Pick<BackgroundTaskSetting, "kind">,
  value: BackgroundTaskConfig[BackgroundTaskSettingId],
) => formatSettingValue(setting.kind, value);

export const sessionValue = (
  config: BackgroundTaskConfig,
  setting: Pick<BackgroundTaskSetting, "id" | "kind">,
) => settingDisplayValue(setting, config[setting.id]);

/** `inherit (on)` and other inherited labels mean `inherit` when chosen. */
export const inheritChoice = (value: string): string =>
  isInheritedSettingValue(value) ? INHERIT : value;

export const TASK_SETTING_DESCRIPTORS = Arr.map(BACKGROUND_TASK_SETTINGS, (setting) => ({
  id: setting.id,
  label: setting.label,
  description: setting.description,
  ...(setting.commandValues.length > 0 && { values: [...setting.commandValues, INHERIT] }),
  openValues: setting.openValues,
  currentValue: (config: BackgroundTaskConfig) => sessionValue(config, setting),
}));

export const TASK_SETTINGS_COMMAND = {
  name: "settings",
  description: "Task settings",
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
