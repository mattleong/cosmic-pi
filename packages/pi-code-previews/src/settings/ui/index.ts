import { getSettingsListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type SettingItem } from "@earendil-works/pi-tui";
import {
  createSettingsGroupSubmenu,
  managerSettingsTheme,
  type SettingsSurfaceItem,
} from "pi-cosmic-ui/manager/settings-surface";
import { getSettingsPath } from "../../config/store";
import type { CodePreviewSettings } from "../../config/schema";
import { formatSettingValue } from "../../config/values";
import { ThemeSelectSubmenu, ToolPreviewSettingsSubmenu } from "./submenus";
import {
  SETTING_ITEM_DEFINITIONS,
  type SettingItemDefinition,
  type SettingsUiItemId,
} from "./registry";
import {
  summarizeAppearance,
  summarizeBashPreviews,
  summarizeDiffPreviews,
  summarizeOutputPreviews,
  summarizeReadPreviews,
  summarizeSearchListPreviews,
  summarizeTools,
  summarizeWarnings,
  summarizeWritePreviews,
} from "./summaries";

type SettingsProvider = () => CodePreviewSettings;
type SettingChangeHandler = (id: string, value: string) => void;
type SettingsGroupDefinition = {
  name: string;
  label: string;
  description: string;
  summarize: (settings: CodePreviewSettings) => string;
  items: (
    current: CodePreviewSettings,
    getCurrent: SettingsProvider,
    onSettingChange: SettingChangeHandler,
    theme?: Theme,
  ) => SettingItem[];
};

const SETTINGS_GROUP_ID_PREFIX = "group:";

const SETTINGS_CATEGORY_GROUPS = [
  {
    name: "appearance",
    label: "Appearance",
    description: "Theme, syntax color, collapsed style, tool frames, timing, and path decoration.",
    summarize: summarizeAppearance,
    items: (current, _getCurrent, _onSettingChange, theme) =>
      createSettingListItems(
        current,
        [
          "shikiTheme",
          "syntaxHighlighting",
          "toolCallBackground",
          "toolCallCollapsedStyle",
          "toolCallTiming",
          "readLineNumbers",
          "pathIcons",
        ],
        theme,
      ),
  },
  {
    name: "outputPreviews",
    label: "Output previews",
    description:
      "Collapsed output/code visibility and preview lengths in preview style. Compact style hides ordinary previews until expanded.",
    summarize: summarizeOutputPreviews,
    items: (current, getCurrent, onSettingChange, theme) =>
      OUTPUT_PREVIEW_GROUPS.map((group) =>
        createSettingsGroupItemFromDefinition(group, current, getCurrent, onSettingChange, theme),
      ),
  },
  {
    name: "warningsSafety",
    label: "Warnings & safety",
    description: "Preview-only safety warnings for shell commands and secret-looking values.",
    summarize: summarizeWarnings,
    items: (current) => createSettingListItems(current, ["bashWarnings", "secretWarnings"]),
  },
  {
    name: "advanced",
    label: "Advanced",
    description: "Settings file location and restore defaults.",
    summarize: () => "file & defaults",
    items: (current) => createSettingListItems(current, ["settingsFile", "resetToDefaults"]),
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
      currentValue: summarizeTools(current),
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
        items: () => definition.items(getCurrent(), getCurrent, onSettingChange, theme),
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

const OUTPUT_PREVIEW_GROUPS: SettingsGroupDefinition[] = [
  {
    name: "readPreviews",
    label: "Read previews",
    description: "File content visibility and collapsed read size.",
    summarize: summarizeReadPreviews,
    items: (current) =>
      createSettingListItems(current, ["readContentPreview", "readCollapsedLines"]),
  },
  {
    name: "writePreviews",
    label: "Write previews",
    description: "Write content/diff visibility and collapsed write content size.",
    summarize: summarizeWritePreviews,
    items: (current) =>
      createSettingListItems(current, ["writeContentPreview", "writeCollapsedLines"]),
  },
  {
    name: "diffPreviews",
    label: "Edit diff previews",
    description: "Edit diff visibility, backgrounds, word emphasis, and collapsed size.",
    summarize: summarizeDiffPreviews,
    items: (current) =>
      createSettingListItems(current, [
        "diffIntensity",
        "wordEmphasis",
        "editDiffPreview",
        "editCollapsedLines",
      ]),
  },
  {
    name: "searchListPreviews",
    label: "Search/list previews",
    description: "Grep, find, and ls result visibility plus collapsed sizes.",
    summarize: summarizeSearchListPreviews,
    items: (current) =>
      createSettingListItems(current, [
        "grepResultPreview",
        "grepCollapsedLines",
        "findResultPreview",
        "lsResultPreview",
        "pathListCollapsedLines",
      ]),
  },
  {
    name: "bashPreviews",
    label: "Bash previews",
    description: "Successful bash output visibility.",
    summarize: summarizeBashPreviews,
    items: (current) => createSettingListItems(current, ["bashResultPreview"]),
  },
];

function createSettingListItems(
  current: CodePreviewSettings,
  ids: readonly SettingsUiItemId[],
  theme?: Theme,
): SettingItem[] {
  return ids.map((id) => createSettingItem(current, id, theme));
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
