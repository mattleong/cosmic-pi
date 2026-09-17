import type { Theme } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import type { LoadSettingsOptions } from "../config/document-store";
import type { CodePreviewSettings } from "../config/schema";
import { cloneCodePreviewSettings, codePreviewSettings } from "../config/state";
import { updateSetting } from "../config/values";
import {
  flushSettingsSaveQueue,
  formatSettingsSaveError,
  queueSettingsSave,
} from "../config/store";
import { initializeShiki } from "../syntax/shiki";
import { createSettingsCategoryItems, isSettingsGroupItemId } from "./ui/index";

interface SettingsListControllerOptions {
  theme?: Theme;
  notify: (message: string, level: "info" | "warning") => void;
  done: () => void;
  loadOptions: LoadSettingsOptions;
}

export interface SettingsPanelSaveEffects {
  readonly queueSave: (
    settings: CodePreviewSettings,
    options: LoadSettingsOptions,
  ) => Promise<void>;
  readonly initializeSyntax: (theme: CodePreviewSettings["shikiTheme"]) => Promise<void>;
}

const liveSettingsPanelSaveEffects: SettingsPanelSaveEffects = {
  queueSave: queueSettingsSave,
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
}: SettingsListControllerOptions): CodePreviewSettingsModel {
  let activeList: SettingsList | undefined;
  let draftSettings = cloneCodePreviewSettings(codePreviewSettings);
  let revision = 0;
  const handleSettingChange = (list: SettingsList, id: string, value: string) => {
    if (isSettingsGroupItemId(id)) {
      syncSettingsListValues(list, draftSettings, (nextId, nextValue) =>
        handleSettingChange(list, nextId, nextValue),
      );
      return;
    }

    const previousTheme = draftSettings.shikiTheme;
    const resetRequested = id === "resetToDefaults" && value === "reset now";
    const next = updateSetting(draftSettings, id, value);
    const changeRevision = ++revision;
    draftSettings = next;
    syncSettingsListValues(list, draftSettings, (nextId, nextValue) =>
      handleSettingChange(list, nextId, nextValue),
    );
    void persistSettingsChange(next, previousTheme, loadOptions)
      .then(() => {
        if (resetRequested) notify("Code preview settings reset to defaults", "info");
      })
      .catch((error) => {
        // Only the latest failed edit rolls the panel draft back. Older saves may fail while a
        // newer serialized save is still able to publish the complete draft.
        if (revision === changeRevision) {
          draftSettings = cloneCodePreviewSettings(codePreviewSettings);
          syncSettingsListValues(list, draftSettings, (nextId, nextValue) =>
            handleSettingChange(list, nextId, nextValue),
          );
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

function syncSettingsListValues(
  list: SettingsList,
  settings: typeof codePreviewSettings,
  onSettingChange: (id: string, value: string) => void,
): void {
  for (const item of createSettingsCategoryItems(settings, () => settings, onSettingChange))
    list.updateValue(item.id, item.currentValue);
}
