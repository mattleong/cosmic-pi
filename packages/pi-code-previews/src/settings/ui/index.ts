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

const SETTINGS_GROUP_ID_PREFIX = "group:";

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

const SETTINGS_CATEGORY_GROUPS = [
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
] as const satisfies readonly SettingsGroupDefinition[];

export function createSettingsCategoryItems(
  current: CodePreviewSettings,
  getCurrent: SettingsProvider,
  onSettingChange: SettingChangeHandler,
  theme?: Theme,
): SettingItem[] {
  const groupItem = (definition: SettingsGroupDefinition) =>
    createSettingsGroupItemFromDefinition(definition, current, getCurrent, onSettingChange, theme);
  return [
    groupItem(SETTINGS_CATEGORY_GROUPS[0]),
    groupItem(SETTINGS_CATEGORY_GROUPS[1]),
    {
      id: "tools",
      label: "Enabled tools",
      description:
        "Toggle tool previews individually. Changes take effect after /reload. Tools already owned by another extension are skipped automatically.",
      currentValue:
        current.tools.length === 0
          ? "none"
          : current.tools.length === ALL_CODE_PREVIEW_TOOLS.length
            ? "all tools"
            : `${current.tools.length}/${ALL_CODE_PREVIEW_TOOLS.length} tools`,
      submenu: (_currentValue, done) =>
        new ToolPreviewSettingsSubmenu(formatSettingValue(getCurrent(), "tools"), done, theme),
    },
    groupItem(SETTINGS_CATEGORY_GROUPS[2]),
    groupItem(SETTINGS_CATEGORY_GROUPS[3]),
  ];
}

function createSettingsGroupItemFromDefinition(
  definition: SettingsGroupDefinition,
  current: CodePreviewSettings,
  getCurrent: SettingsProvider,
  onSettingChange: SettingChangeHandler,
  theme?: Theme,
): SettingsSurfaceItem {
  return {
    kind: "group",
    id: `${SETTINGS_GROUP_ID_PREFIX}${definition.name}`,
    label: definition.label,
    description: definition.description,
    currentValue: definition.summarize(current),
    submenu: (_currentValue, done) =>
      createSettingsGroupSubmenu({
        title: definition.label,
        description: definition.description,
        items: () =>
          definition.groups?.map((group) =>
            createSettingsGroupItemFromDefinition(
              group,
              getCurrent(),
              getCurrent,
              onSettingChange,
              theme,
            ),
          ) ?? (definition.ids ?? []).map((id) => createSettingItem(getCurrent(), id, theme)),
        onChange: onSettingChange,
        done,
        summary: () => definition.summarize(getCurrent()),
        listTheme: theme ? managerSettingsTheme(theme) : getSettingsListTheme(),
      }),
  };
}

export function isSettingsGroupItemId(id: string): boolean {
  return id.startsWith(SETTINGS_GROUP_ID_PREFIX);
}

function createSettingItem(
  current: CodePreviewSettings,
  id: SettingsUiItemId,
  theme?: Theme,
): SettingItem {
  // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
  const definition = SETTING_ITEM_DEFINITIONS[id] as SettingItemDefinition;
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
