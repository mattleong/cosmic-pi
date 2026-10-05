import type { Theme } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { constVoid } from "effect/Function";
import type { CodePreviewSettings } from "../config/schema";
import { cloneCodePreviewSettings, codePreviewSettings } from "../config/state";
import { updateSetting } from "../config/values";
import {
  flushSettingsSaveQueue,
  formatSettingsSaveError,
  queueSettingsReset,
  queueSettingsSave,
  type LoadSettingsOptions,
} from "../config/store";
import { initializeShiki } from "../syntax/shiki";
import { createSettingsCategoryItems, isSettingsGroupItemId } from "./ui/index";

interface SettingsListControllerOptions {
  theme?: Theme;
  notify: (message: string, level: "info" | "warning") => void;
  done: () => void;
  loadOptions: LoadSettingsOptions;
  effects?: SettingsPanelSaveEffects;
}

export interface SettingsPanelSaveEffects {
  readonly queueSave: (
    settings: CodePreviewSettings,
    options: LoadSettingsOptions,
  ) => Promise<void>;
  readonly queueReset: (options: LoadSettingsOptions) => Promise<void>;
  readonly initializeSyntax: (theme: CodePreviewSettings["shikiTheme"]) => Promise<void>;
}

const liveSettingsPanelSaveEffects: SettingsPanelSaveEffects = {
  queueSave: queueSettingsSave,
  queueReset: queueSettingsReset,
  initializeSyntax: initializeShiki,
};

export function persistSettingsChange(
  settings: CodePreviewSettings,
  previousTheme: CodePreviewSettings["shikiTheme"],
  loadOptions: LoadSettingsOptions,
  effects: SettingsPanelSaveEffects = liveSettingsPanelSaveEffects,
): Promise<void> {
  return effects.queueSave(settings, loadOptions).then(() => {
    if (settings.shikiTheme !== previousTheme)
      void effects.initializeSyntax(settings.shikiTheme).catch(() => undefined);
  });
}

export interface CodePreviewSettingsModel {
  readonly items: SettingItem[];
  readonly bind: (list: SettingsList) => void;
  readonly onChange: (id: string, value: string, list: SettingsList) => void;
  readonly onCancel: () => void;
}

export function createCodePreviewSettingsModel({
  notify,
  done,
  loadOptions,
  theme,
  effects = liveSettingsPanelSaveEffects,
}: SettingsListControllerOptions): CodePreviewSettingsModel {
  let activeList: SettingsList | undefined;
  let draftSettings = cloneCodePreviewSettings(codePreviewSettings);
  let revision = 0;
  const sync = (list: SettingsList) => syncSettingsListValues(list, draftSettings);
  const handleSettingChange = (list: SettingsList, id: string, value: string) => {
    if (isSettingsGroupItemId(id)) {
      sync(list);
      return;
    }

    // The reset row asks for a second press: its middle value only arms the reset.
    if (id === "resetToDefaults" && value !== "reset now") {
      if (value === "keep current") sync(list);
      return;
    }
    const previousTheme = draftSettings.shikiTheme;
    const changeRevision = ++revision;
    let saved: Promise<void>;
    if (id === "resetToDefaults") {
      // The restored values come from the settings files, so the draft follows the publication.
      sync(list);
      saved = effects.queueReset(loadOptions).then(() => {
        if (revision === changeRevision) {
          draftSettings = cloneCodePreviewSettings(codePreviewSettings);
          sync(list);
        }
        if (codePreviewSettings.shikiTheme !== previousTheme)
          void effects.initializeSyntax(codePreviewSettings.shikiTheme).catch(() => undefined);
        notify("Code preview settings restored to defaults", "info");
      });
    } else {
      const next = updateSetting(draftSettings, id, value);
      draftSettings = next;
      sync(list);
      saved = persistSettingsChange(next, previousTheme, loadOptions, effects);
    }
    void saved.catch((error) => {
      // Only the latest failed edit rolls the panel draft back. Older saves may fail while a
      // newer serialized save is still able to publish the complete draft.
      if (revision === changeRevision) {
        draftSettings = cloneCodePreviewSettings(codePreviewSettings);
        sync(list);
      }
      notify(formatSettingsSaveError(error), "warning");
    });
  };
  const routeBoundChange = (id: string, value: string): void => {
    if (activeList) handleSettingChange(activeList, id, value);
  };
  return {
    items: createSettingsCategoryItems(draftSettings, () => draftSettings, routeBoundChange, theme),
    bind: (list) => {
      activeList = list;
    },
    onChange: (id, value, list) => {
      activeList = list;
      handleSettingChange(list, id, value);
    },
    onCancel: () => {
      void flushSettingsSaveQueue()
        .catch(() => undefined)
        .finally(done);
    },
  };
}

function syncSettingsListValues(list: SettingsList, settings: typeof codePreviewSettings): void {
  for (const item of createSettingsCategoryItems(settings, () => settings, constVoid, undefined))
    list.updateValue(item.id, item.currentValue);
}
