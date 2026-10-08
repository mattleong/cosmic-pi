import { getSettingsListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type SettingItem } from "@earendil-works/pi-tui";
import {
  createSettingsGroupSubmenu,
  managerSettingsTheme,
  type SettingsSurfaceItem,
} from "pi-cosmic-ui/manager/settings-surface";
import { getSettingsPath } from "../../config/store";
import type { CodePreviewSettings } from "../../config/schema";
import { formatOnOff, formatSettingValue } from "../../config/values";
import { ALL_CODE_PREVIEW_TOOLS } from "../../tools/names";
import { getEffectiveCodePreviewToolSet } from "../../tools/policy";
import { ThemeSelectSubmenu, ToolPreviewSettingsSubmenu } from "./submenus";
import {
  SETTING_ITEM_DEFINITIONS,
  type SettingItemDefinition,
  type SettingsUiItemId,
} from "./registry";

type SettingsProvider = () => CodePreviewSettings;
type SettingChangeHandler = (id: string, value: string) => void;
type SettingsGroupDefinition = {
  name: string;
  label: string;
  description: string;
  summarize: (settings: CodePreviewSettings) => string;
  ids?: readonly SettingsUiItemId[];
  groups?: readonly SettingsGroupDefinition[];
};

const OUTPUT_PREVIEW_GROUPS: SettingsGroupDefinition[] = [
  {
    name: "readPreviews",
    label: "Read previews",
    description: "File content visibility and collapsed read size.",
    summarize: (settings) =>
      `${formatOnOff(settings.readContentPreview)} · ${settings.readCollapsedLines} lines`,
    ids: ["readContentPreview", "readCollapsedLines"],
  },
  {
    name: "writePreviews",
    label: "Write previews",
    description: "Write content/diff visibility and collapsed write content size.",
    summarize: (settings) =>
      `${formatOnOff(settings.writeContentPreview)} · ${settings.writeCollapsedLines} lines`,
    ids: ["writeContentPreview", "writeCollapsedLines"],
  },
  {
    name: "diffPreviews",
    label: "Edit diff previews",
    description: "Edit diff visibility, backgrounds, word emphasis, and collapsed size.",
    summarize: (settings) =>
      `${formatOnOff(settings.editDiffPreview)} · ${settings.diffIntensity} bg · words ${settings.wordEmphasis}`,
    ids: ["diffIntensity", "wordEmphasis", "editDiffPreview", "editCollapsedLines"],
  },
  {
    name: "searchListPreviews",
    label: "Search/list previews",
    description: "Grep, find, and ls result visibility plus collapsed sizes.",
    summarize: (settings) =>
      `grep ${formatOnOff(settings.grepResultPreview)} · paths ${settings.pathListCollapsedLines} lines`,
    ids: [
      "grepResultPreview",
      "grepCollapsedLines",
      "findResultPreview",
      "lsResultPreview",
      "pathListCollapsedLines",
    ],
  },
  {
    name: "bashPreviews",
    label: "Bash previews",
    description: "Successful bash output visibility.",
    summarize: (settings) => formatOnOff(settings.bashResultPreview),
    ids: ["bashResultPreview"],
  },
];

const SETTINGS_CATEGORY_GROUPS: readonly SettingsGroupDefinition[] = [
  {
    name: "appearance",
    label: "Appearance",
    description: "Theme, syntax color, collapsed style, tool frames, timing, and path decoration.",
    summarize: (settings) =>
      `${settings.shikiTheme} · ${settings.toolCallCollapsedStyle} · syntax ${formatOnOff(settings.syntaxHighlighting)} · timing ${formatOnOff(settings.toolCallTiming)}`,
    ids: [
      "shikiTheme",
      "syntaxHighlighting",
      "toolCallBackground",
      "toolCallCollapsedStyle",
      "toolCallTiming",
      "readLineNumbers",
      "pathIcons",
    ],
  },
  {
    name: "outputPreviews",
    label: "Output previews",
    description:
      "Collapsed output/code visibility and preview lengths in preview style. Compact style hides ordinary previews until expanded.",
    summarize: (settings) =>
      `read ${formatOnOff(settings.readContentPreview)} · write ${formatOnOff(settings.writeContentPreview)} · edit ${formatOnOff(settings.editDiffPreview)} · bash ${formatOnOff(settings.bashResultPreview)}`,
    groups: OUTPUT_PREVIEW_GROUPS,
  },
  {
    name: "warningsSafety",
    label: "Warnings & safety",
    description: "Preview-only safety warnings for shell commands and secret-looking values.",
    summarize: (settings) =>
      `bash ${formatOnOff(settings.bashWarnings)} · secrets ${formatOnOff(settings.secretWarnings)}`,
    ids: ["bashWarnings", "secretWarnings"],
  },
  {
    name: "advanced",
    label: "Advanced",
    description: "Settings file location and restore defaults.",
    summarize: () => "file & defaults",
    ids: ["settingsFile", "resetToDefaults"],
  },
];

export function createSettingsCategoryItems(
  getCurrent: SettingsProvider,
  onSettingChange: SettingChangeHandler,
  theme?: Theme,
): SettingItem[] {
  const groupItem = (definition: SettingsGroupDefinition) =>
    createSettingsGroupItemFromDefinition(definition, getCurrent, onSettingChange, theme);
  const { tools } = getCurrent();
  return [
    ...SETTINGS_CATEGORY_GROUPS.slice(0, 2).map(groupItem),
    {
      id: "tools",
      label: "Enabled tools",
      description:
        "Toggle tool previews individually. Changes take effect after /reload. Tools already owned by another extension are skipped automatically.",
      currentValue:
        tools.length === 0
          ? "none"
          : tools.length === ALL_CODE_PREVIEW_TOOLS.length
            ? "all tools"
            : `${tools.length}/${ALL_CODE_PREVIEW_TOOLS.length} tools`,
      submenu: (_currentValue, done) => {
        const settings = getCurrent();
        return new ToolPreviewSettingsSubmenu(
          settings.tools,
          done,
          theme,
          // Tools whose preview setting is off still render, to hide that preview.
          getEffectiveCodePreviewToolSet([], settings),
        );
      },
    },
    ...SETTINGS_CATEGORY_GROUPS.slice(2).map(groupItem),
  ];
}

function createSettingsGroupItemFromDefinition(
  definition: SettingsGroupDefinition,
  getCurrent: SettingsProvider,
  onSettingChange: SettingChangeHandler,
  theme?: Theme,
): SettingsSurfaceItem {
  return {
    kind: "group",
    id: `group:${definition.name}`,
    label: definition.label,
    description: definition.description,
    currentValue: definition.summarize(getCurrent()),
    submenu: (_currentValue, done) =>
      createSettingsGroupSubmenu({
        title: definition.label,
        description: definition.description,
        items: () =>
          definition.groups?.map((group) =>
            createSettingsGroupItemFromDefinition(group, getCurrent, onSettingChange, theme),
          ) ?? (definition.ids ?? []).map((id) => createSettingItem(getCurrent(), id, theme)),
        onChange: onSettingChange,
        done,
        summary: () => definition.summarize(getCurrent()),
        listTheme: theme ? managerSettingsTheme(theme) : getSettingsListTheme(),
      }),
  };
}

function createSettingItem(
  current: CodePreviewSettings,
  id: SettingsUiItemId,
  theme?: Theme,
): SettingItem {
  const definition: SettingItemDefinition = SETTING_ITEM_DEFINITIONS[id];
  const item: SettingItem = {
    id,
    label: definition.label,
    description: definition.description,
    currentValue: id === "settingsFile" ? getSettingsPath() : formatSettingValue(current, id),
  };
  if (definition.values) item.values = [...definition.values];
  if (id === "shikiTheme")
    item.submenu = (currentValue, done) => new ThemeSelectSubmenu(currentValue, done, theme);
  return item;
}
