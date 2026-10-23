import type { Theme } from "@earendil-works/pi-coding-agent";
import { type SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import * as Arr from "effect/Array";
import { CODE_PREVIEW_SETTING_KEYS, type CodePreviewSettings } from "../config/schema";
import { cloneCodePreviewSettings, codePreviewSettings } from "../config/state";
import { updateSetting } from "../config/values";
import {
  CodePreviewSettingsSuperseded,
  flushSettingsSaveQueue,
  formatSettingsSaveError,
  queueSettingsReset,
  queueSettingsSave,
  type LoadSettingsOptions,
} from "../config/store";
import { initializeShiki } from "../syntax/shiki";
import { createSettingsCategoryItems } from "./ui/index";

type SettingKey = keyof CodePreviewSettings;

const isSettingsSuperseded = Schema.is(CodePreviewSettingsSuperseded);

function copySetting<K extends SettingKey>(
  target: Pick<CodePreviewSettings, K>,
  source: Pick<CodePreviewSettings, K>,
  key: K,
): void {
  target[key] = source[key];
}

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
  isCurrent: () => boolean = Fn.constTrue,
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
  isCurrent = Fn.constTrue,
  effects = liveSettingsPanelSaveEffects,
}: SettingsListControllerOptions): CodePreviewSettingsModel {
  let activeList: SettingsList | undefined;
  let draftSettings = cloneCodePreviewSettings(codePreviewSettings);
  let revision = 0;
  // Latest pending panel revision per edited setting; those draft values outrank the published ones.
  const pendingEdits = new Map<SettingKey, number>();
  const sync = (list: SettingsList) => {
    if (!isCurrent()) return;
    for (const item of createSettingsCategoryItems(() => draftSettings, Fn.constVoid))
      list.updateValue(item.id, item.currentValue);
  };
  // Saves may settle out of admission order, so each settlement rebases the draft on the canonical
  // settings rather than trusting whichever save happened to be admitted last.
  const settle = (
    list: SettingsList,
    settled: (key: SettingKey, pendingRevision: number) => boolean,
  ) => {
    for (const [key, pendingRevision] of pendingEdits)
      if (settled(key, pendingRevision)) pendingEdits.delete(key);
    const rebased = cloneCodePreviewSettings(codePreviewSettings);
    for (const key of pendingEdits.keys()) copySetting(rebased, draftSettings, key);
    draftSettings = rebased;
    sync(list);
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
        // The reset superseded every earlier panel edit, whichever order they settle in.
        settle(list, (_key, pendingRevision) => pendingRevision < changeRevision);
        if (codePreviewSettings.shikiTheme !== previous.shikiTheme)
          void effects.initializeSyntax(codePreviewSettings.shikiTheme).catch(() => undefined);
        notify("Code preview settings restored to defaults", "info");
        return undefined;
      });
    } else {
      const editedKeys = Arr.filter(CODE_PREVIEW_SETTING_KEYS, (key) => key === id);
      const next = updateSetting(draftSettings, id, value);
      draftSettings = next;
      for (const edited of editedKeys) pendingEdits.set(edited, changeRevision);
      sync(list);
      // An explicit assignment is an edit even when a stale draft already shows the same value.
      saved = persistSettingsChange(
        next,
        previous,
        loadOptions,
        effects,
        isCurrent,
        editedKeys,
      ).finally(() => {
        if (!isCurrent()) return;
        settle(list, (pending, pendingRevision) =>
          Arr.some(
            editedKeys,
            (edited) => edited === pending && pendingRevision === changeRevision,
          ),
        );
      });
    }
    void saved.catch((cause: unknown) => {
      if (!isCurrent()) return;
      if (id === "resetToDefaults") settle(list, () => false);
      // A later panel change to the same setting already saved the user's newest value.
      if (revision !== changeRevision && isSettingsSuperseded(cause)) return;
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
