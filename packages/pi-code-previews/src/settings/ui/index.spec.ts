import assert from "node:assert/strict";
import { test } from "vitest";
import { createSettingsCategoryItems, isSettingsGroupItemId } from "./index";
import { SETTING_ITEM_DEFINITIONS, type SettingItemDefinition } from "./registry";
import { CODE_PREVIEW_SETTING_KEYS, defaultCodePreviewSettings, updateSetting } from "../index";

test("settings registry defines every setting item", () => {
  for (const [id, definition] of Object.entries(SETTING_ITEM_DEFINITIONS) as Array<
    [string, SettingItemDefinition]
  >) {
    assert.ok(definition.label.trim(), `${id} has a label`);
    assert.ok(definition.description.trim(), `${id} has a description`);
    if (definition.values) assert.ok(definition.values.length > 0, `${id} has value options`);
  }
});

test("settings UI item values are handled by updateSetting", () => {
  assert.deepEqual(
    Object.keys(SETTING_ITEM_DEFINITIONS)
      .filter((id) => id !== "settingsFile")
      .sort(),
    [...CODE_PREVIEW_SETTING_KEYS, "resetToDefaults"].sort(),
  );

  for (const [id, value, expected] of [
    ["shikiTheme", "github-dark", "github-dark"],
    ["diffIntensity", "medium", "medium"],
    ["wordEmphasis", "smart", "smart"],
    ["toolCallBackground", "off", "off"],
    ["toolCallBackground", "border", "border"],
    ["toolCallTiming", "off", false],
    ["readContentPreview", "off", false],
    ["readCollapsedLines", "20", 20],
    ["writeContentPreview", "off", false],
    ["writeCollapsedLines", "20", 20],
    ["editDiffPreview", "off", false],
    ["editCollapsedLines", "all", "all"],
    ["grepResultPreview", "off", false],
    ["grepCollapsedLines", "25", 25],
    ["findResultPreview", "off", false],
    ["lsResultPreview", "off", false],
    ["pathListCollapsedLines", "40", 40],
    ["readLineNumbers", "off", false],
    ["pathIcons", "off", "off"],
    ["bashResultPreview", "off", false],
    ["bashWarnings", "off", false],
    ["syntaxHighlighting", "off", false],
    ["secretWarnings", "off", false],
  ] as const) {
    assert.equal(updateSetting(defaultCodePreviewSettings, id, value)[id], expected, id);
  }

  assert.deepEqual(updateSetting(defaultCodePreviewSettings, "tools", "none").tools, []);
  assert.deepEqual(
    updateSetting(
      { ...defaultCodePreviewSettings, readCollapsedLines: 21 },
      "resetToDefaults",
      "reset now",
    ),
    defaultCodePreviewSettings,
  );
});

test("settings panel categories keep the top level compact", () => {
  const items = createSettingsCategoryItems(
    defaultCodePreviewSettings,
    () => defaultCodePreviewSettings,
    () => undefined,
  );
  assert.deepEqual(
    items.map((item) => item.label),
    ["Appearance", "Output previews", "Enabled tools", "Warnings & safety", "Advanced"],
  );
  assert.equal(items.filter((item) => isSettingsGroupItemId(item.id)).length, 4);
  assert.equal(items.find((item) => item.id === "tools")?.currentValue, "all tools");
});

test("empty tool selections stay explicit in the settings UI", () => {
  const current = { ...defaultCodePreviewSettings, tools: [] };
  const items = createSettingsCategoryItems(
    current,
    () => current,
    () => undefined,
  );
  assert.equal(items.find((item) => item.id === "tools")?.currentValue, "none");
  assert.deepEqual(updateSetting(defaultCodePreviewSettings, "tools", "none").tools, []);
});

test("invalid setting updates preserve current values", () => {
  const current = {
    ...defaultCodePreviewSettings,
    diffIntensity: "medium" as const,
    pathIcons: "nerd" as const,
    readCollapsedLines: 33,
  };
  assert.equal(updateSetting(current, "diffIntensity", "loud").diffIntensity, "medium");
  assert.equal(updateSetting(current, "pathIcons", "emoji").pathIcons, "nerd");
  assert.equal(updateSetting(current, "readCollapsedLines", "nope").readCollapsedLines, 33);
});
