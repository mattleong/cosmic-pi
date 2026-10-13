import type { Theme } from "@earendil-works/pi-coding-agent";
import { type SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { constTrue, constVoid } from "effect/Function";
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
import { createSettingsCategoryItems } from "./ui/index";

interface SettingsListControllerOptions {
  theme?: Theme;
  notify: (message: string, level: "info" | "warning") => void;
  done: () => void;
  loadOptions: LoadSettingsOptions;
  isCurrent?: () => boolean;
  effects?: SettingsPanelSaveEffects;
}

interface SettingsPanelSaveEffects {
  readonly queueSave: (
    settings: CodePreviewSettings,
    options: LoadSettingsOptions,
    previous: CodePreviewSettings,
    editedKeys?: readonly (keyof CodePreviewSettings)[],
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
  previous: CodePreviewSettings,
  loadOptions: LoadSettingsOptions,
  effects: SettingsPanelSaveEffects = liveSettingsPanelSaveEffects,
  isCurrent: () => boolean = constTrue,
  editedKeys?: readonly (keyof CodePreviewSettings)[],
): Promise<void> {
  return effects.queueSave(settings, loadOptions, previous, editedKeys).then(() => {
    if (isCurrent() && codePreviewSettings.shikiTheme !== previous.shikiTheme)
      void effects.initializeSyntax(codePreviewSettings.shikiTheme).catch(() => undefined);
    return undefined;
  });
}

interface CodePreviewSettingsModel {
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
  isCurrent = constTrue,
  effects = liveSettingsPanelSaveEffects,
}: SettingsListControllerOptions): CodePreviewSettingsModel {
  let activeList: SettingsList | undefined;
  let draftSettings = cloneCodePreviewSettings(codePreviewSettings);
  let revision = 0;
  const sync = (list: SettingsList) => {
    if (!isCurrent()) return;
    for (const item of createSettingsCategoryItems(() => draftSettings, constVoid))
      list.updateValue(item.id, item.currentValue);
  };
  const handleSettingChange = (list: SettingsList, id: string, value: string) => {
    if (!isCurrent()) return;
    if (id === "resetToDefaults" && value !== "reset now") {
      if (value === "keep current") sync(list);
      return;
    }
    const previous = draftSettings;
    const changeRevision = ++revision;
    let saved: Promise<void>;
    if (id === "resetToDefaults") {
      sync(list);
      saved = effects.queueReset(loadOptions).then(() => {
        if (!isCurrent()) return undefined;
        if (revision === changeRevision) {
          draftSettings = cloneCodePreviewSettings(codePreviewSettings);
          sync(list);
        }
        if (codePreviewSettings.shikiTheme !== previous.shikiTheme)
          void effects.initializeSyntax(codePreviewSettings.shikiTheme).catch(() => undefined);
        notify("Code preview settings restored to defaults", "info");
        return undefined;
      });
    } else {
      const next = updateSetting(draftSettings, id, value);
      draftSettings = next;
      sync(list);
      saved = persistSettingsChange(next, previous, loadOptions, effects, isCurrent).then(() => {
        if (isCurrent() && revision === changeRevision) {
          draftSettings = cloneCodePreviewSettings(codePreviewSettings);
          sync(list);
        }
        return undefined;
      });
    }
    void saved.catch((cause: unknown) => {
      if (!isCurrent()) return;
      if (revision === changeRevision) {
        draftSettings = cloneCodePreviewSettings(codePreviewSettings);
        sync(list);
      }
      notify(formatSettingsSaveError(cause), "warning");
    });
  };
  const routeBoundChange = (id: string, value: string): void => {
    if (activeList) handleSettingChange(activeList, id, value);
  };
  return {
    items: createSettingsCategoryItems(() => draftSettings, routeBoundChange, theme),
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
