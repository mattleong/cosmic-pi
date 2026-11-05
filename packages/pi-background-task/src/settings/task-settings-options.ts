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

/** A value as settings show it; an empty shell names the shell that applies, Pi's own. */
export const effectiveDisplayValue = (
  setting: Pick<BackgroundTaskSetting, "kind">,
  value: BackgroundTaskConfig[BackgroundTaskSettingId],
) => settingDisplayValue(setting, value) || "Pi's shell";

/** The value this session started with. */
export const sessionValue = (
  config: BackgroundTaskConfig,
  setting: Pick<BackgroundTaskSetting, "id" | "kind">,
) => effectiveDisplayValue(setting, config[setting.id]);

/** `inherit (on)` and other inherited labels mean `inherit` when chosen. */
export const inheritChoice = (value: string): string =>
  isInheritedSettingValue(value) ? INHERIT : value;

export const TASK_SETTING_DESCRIPTORS = Arr.map(BACKGROUND_TASK_SETTINGS, (setting) => ({
  id: setting.id,
  label: setting.label,
  description: setting.description,
  ...(setting.commandValues.length > 0 && { values: [...setting.commandValues, INHERIT] }),
  openValues: setting.openValues,
  // The missing-value hint names the same placeholder as the row's description.
  ...(setting.kind === "path" && { valuePlaceholder: "<path>" }),
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
        { value: "status", label: "status", description: "Show current values" },
        { value: "help", label: "help", description: "Show setting ids" },
      ],
      Arr.map(SCOPES, (scope) => ({
        value: scope.name,
        label: scope.name,
        description: scope.description,
      })),
    ),
};
