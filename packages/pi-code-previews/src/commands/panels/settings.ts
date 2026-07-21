import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { SettingsList } from "@earendil-works/pi-tui";
import { cloneCodePreviewSettings, codePreviewSettings, updateSetting } from "../../settings/index";
import {
  flushSettingsSaveQueue,
  formatSettingsSaveError,
  queueSettingsSave,
} from "../../settings/persistence";
import { createSettingsCategoryItems, isSettingsGroupItemId } from "../../settings/ui/index";
import { initializeShiki } from "../../syntax/shiki";

interface SettingsListControllerOptions {
  notify: (message: string, level: "info" | "warning") => void;
  done: () => void;
}

export function createCodePreviewSettingsList({
  notify,
  done,
}: SettingsListControllerOptions): SettingsList {
  let list: SettingsList;
  let draftSettings = cloneCodePreviewSettings(codePreviewSettings);
  let revision = 0;
  const handleSettingChange = (id: string, value: string) => {
    if (isSettingsGroupItemId(id)) {
      syncSettingsListValues(list, draftSettings, handleSettingChange);
      return;
    }

    const previousTheme = draftSettings.shikiTheme;
    const resetRequested = id === "resetToDefaults" && value === "reset now";
    const next = updateSetting(draftSettings, id, value);
    const changeRevision = ++revision;
    draftSettings = next;
    syncSettingsListValues(list, draftSettings, handleSettingChange);
    void queueSettingsSave(next)
      .then(() => {
        if (next.shikiTheme !== previousTheme) void initializeShiki(next.shikiTheme);
        if (resetRequested) notify("Code preview settings reset to defaults", "info");
      })
      .catch((error) => {
        // Only the latest failed edit rolls the panel draft back. Older saves may fail while a
        // newer serialized save is still able to publish the complete draft.
        if (revision === changeRevision) {
          draftSettings = cloneCodePreviewSettings(codePreviewSettings);
          syncSettingsListValues(list, draftSettings, handleSettingChange);
        }
        notify(formatSettingsSaveError(error), "warning");
      });
  };

  const items = createSettingsCategoryItems(
    draftSettings,
    () => draftSettings,
    handleSettingChange,
  );
  list = new SettingsList(
    items,
    items.length + 2,
    getSettingsListTheme(),
    handleSettingChange,
    () => {
      void flushSettingsSaveQueue()
        .catch(() => undefined)
        .finally(done);
    },
  );
  return list;
}

function syncSettingsListValues(
  list: SettingsList,
  settings: typeof codePreviewSettings,
  onSettingChange: (id: string, value: string) => void,
): void {
  for (const item of createSettingsCategoryItems(settings, () => settings, onSettingChange))
    list.updateValue(item.id, item.currentValue);
}
