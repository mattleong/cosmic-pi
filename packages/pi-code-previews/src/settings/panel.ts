import type { Theme } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { constVoid } from "effect/Function";
import type { LoadSettingsOptions } from "../config/document-store";
import type { CodePreviewSettings, CodePreviewStartupSettings } from "../config/schema";
import { defaultCodePreviewStartupSettings } from "../config/defaults";
import { NATIVE_MCP_SETTING } from "./ui/registry";
import { cloneCodePreviewSettings, codePreviewSettings } from "../config/state";
import { updateSetting } from "../config/values";
import {
  flushSettingsSaveQueue,
  formatSettingsSaveError,
  queueSettingsSave,
  queueStartupSettingsSave,
} from "../config/store";
import { initializeShiki } from "../syntax/shiki";
import { createSettingsCategoryItems, isSettingsGroupItemId } from "./ui/index";

interface SettingsListControllerOptions {
  theme?: Theme;
  notify: (message: string, level: "info" | "warning") => void;
  done: () => void;
  loadOptions: LoadSettingsOptions;
  effects?: SettingsPanelSaveEffects;
  startupSettings?: CodePreviewStartupSettings;
  signal?: AbortSignal | undefined;
}

export interface SettingsPanelSaveEffects {
  readonly queueSave: (
    settings: CodePreviewSettings,
    options: LoadSettingsOptions,
  ) => Promise<void>;
  readonly initializeSyntax: (theme: CodePreviewSettings["shikiTheme"]) => Promise<void>;
  readonly queueStartupSave?: (
    settings: CodePreviewStartupSettings,
    signal?: AbortSignal,
  ) => Promise<CodePreviewStartupSettings>;
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
  effects,
  startupSettings = defaultCodePreviewStartupSettings,
  signal,
}: SettingsListControllerOptions): CodePreviewSettingsModel {
  let activeList: SettingsList | undefined;
  let draftSettings = cloneCodePreviewSettings(codePreviewSettings);
  let revision = 0;
  let draftStartup = { ...startupSettings };
  let committedStartup = { ...startupSettings };
  let startupRevision = 0;
  let committedStartupRevision = 0;
  let pendingStartup = Promise.resolve();
  const sync = (list: SettingsList) => syncSettingsListValues(list, draftSettings, draftStartup);
  const handleSettingChange = (list: SettingsList, id: string, value: string) => {
    if (id === NATIVE_MCP_SETTING.id) {
      if (signal?.aborted) return;
      if (value !== "on" && value !== "off") {
        sync(list);
        return;
      }
      const changeRevision = ++startupRevision;
      draftStartup = { nativeMcpPreviews: value === "on" };
      sync(list);
      const save = (effects?.queueStartupSave ?? queueStartupSettingsSave)(draftStartup, signal)
        .then((saved) => {
          if (signal?.aborted) return;
          if (changeRevision > committedStartupRevision) {
            committedStartupRevision = changeRevision;
            committedStartup = { ...saved };
          }
          if (startupRevision === changeRevision) {
            draftStartup = { ...saved };
            sync(list);
            notify("Native MCP preview changes require /reload", "info");
          }
        })
        .catch((error) => {
          if (signal?.aborted) return;
          if (startupRevision === changeRevision) {
            draftStartup = { ...committedStartup };
            sync(list);
          }
          notify(formatSettingsSaveError(error), "warning");
        });
      pendingStartup = Promise.all([pendingStartup, save]).then(() => undefined);
      return;
    }
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
    const resetRequested = id === "resetToDefaults";
    const next = updateSetting(draftSettings, id, value);
    const changeRevision = ++revision;
    draftSettings = next;
    sync(list);
    void persistSettingsChange(next, previousTheme, loadOptions, effects)
      .then(() => {
        if (resetRequested) notify("Code preview settings restored to defaults", "info");
      })
      .catch((error) => {
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
    items: createSettingsCategoryItems(
      draftSettings,
      () => draftSettings,
      routeBoundChange,
      theme,
      draftStartup,
    ),
    bind: (list) => {
      activeList = list;
    },
    onChange: (id, value, list) => {
      activeList = list;
      handleSettingChange(list, id, value);
    },
    onCancel: () => {
      void pendingStartup
        .then(() => flushSettingsSaveQueue())
        .catch(() => undefined)
        .finally(done);
    },
  };
}

function syncSettingsListValues(
  list: SettingsList,
  settings: typeof codePreviewSettings,
  startup: CodePreviewStartupSettings,
): void {
  for (const item of createSettingsCategoryItems(
    settings,
    () => settings,
    constVoid,
    undefined,
    startup,
  ))
    list.updateValue(item.id, item.currentValue);
}
