import assert from "node:assert/strict";
import { test } from "vitest";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { CODE_PREVIEW_SETTING_KEYS, type CodePreviewSettings } from "../../src/config/schema";
import { codePreviewSettings, setCodePreviewSettings } from "../../src/config/state";
import { normalizeSettingsWithDiagnostics, updateSetting } from "../../src/config/values";

type SettingsFixtureValue = string | number | boolean | readonly string[] | undefined;

const settingsFrom = (
  data: Readonly<Record<string, SettingsFixtureValue>>,
  fallback: CodePreviewSettings = codePreviewSettings,
): CodePreviewSettings => normalizeSettingsWithDiagnostics(data, fallback).settings;

test("settings normalization and reset preserve defaults", () => {
  const normalized = settingsFrom({
    syntaxHighlighting: false,
    secretWarnings: false,
    bashWarnings: false,
    bashResultPreview: false,
    toolCallTiming: false,
    readContentPreview: false,
    writeContentPreview: false,
    editDiffPreview: false,
    grepResultPreview: false,
    findResultPreview: false,
    lsResultPreview: false,
    readCollapsedLines: -1,
    toolCallBackground: "off",
    tools: ["bash", "not-a-tool", "write", "bash"],
  });
  assert.equal(normalized.syntaxHighlighting, false);
  assert.equal(normalized.secretWarnings, false);
  assert.equal(normalized.bashWarnings, false);
  assert.equal(normalized.bashResultPreview, false);
  assert.equal(normalized.toolCallBackground, "off");
  assert.equal(normalized.toolCallTiming, false);
  assert.equal(normalized.readContentPreview, false);
  assert.equal(normalized.writeContentPreview, false);
  assert.equal(normalized.editDiffPreview, false);
  assert.equal(normalized.grepResultPreview, false);
  assert.equal(normalized.findResultPreview, false);
  assert.equal(normalized.lsResultPreview, false);
  assert.equal(normalized.wordEmphasis, defaultCodePreviewSettings.wordEmphasis);
  assert.equal(normalized.readCollapsedLines, defaultCodePreviewSettings.readCollapsedLines);
  assert.deepEqual(normalized.tools, ["bash", "read", "write", "edit", "grep", "find", "ls"]);
  assert.deepEqual(
    updateSetting(normalized, "resetToDefaults", "reset now"),
    defaultCodePreviewSettings,
  );
});

test("settings normalization falls back to accumulated settings for invalid overrides", () => {
  const fallback = {
    ...defaultCodePreviewSettings,
    shikiTheme: "github-dark",
    readCollapsedLines: 40,
  };
  const invalidOverride = settingsFrom(
    { shikiTheme: "not-a-theme", readCollapsedLines: -1 },
    fallback,
  );
  assert.equal(invalidOverride.shikiTheme, "github-dark");
  assert.equal(invalidOverride.readCollapsedLines, 40);

  const validOverride = settingsFrom({ shikiTheme: "dark-plus", readCollapsedLines: 20 }, fallback);
  assert.equal(validOverride.shikiTheme, "dark-plus");
  assert.equal(validOverride.readCollapsedLines, 20);
  assert.equal(updateSetting(validOverride, "wordEmphasis", "all").wordEmphasis, "all");
  assert.equal(updateSetting(validOverride, "readContentPreview", "off").readContentPreview, false);
  assert.equal(
    updateSetting(validOverride, "writeContentPreview", "off").writeContentPreview,
    false,
  );
  assert.equal(updateSetting(validOverride, "editDiffPreview", "off").editDiffPreview, false);
  assert.equal(updateSetting(validOverride, "grepResultPreview", "off").grepResultPreview, false);
  assert.equal(updateSetting(validOverride, "findResultPreview", "off").findResultPreview, false);
  assert.equal(updateSetting(validOverride, "lsResultPreview", "off").lsResultPreview, false);
  assert.equal(updateSetting(validOverride, "bashResultPreview", "off").bashResultPreview, false);
  assert.equal(updateSetting(validOverride, "toolCallTiming", "off").toolCallTiming, false);
  assert.equal(updateSetting(validOverride, "toolCallBackground", "off").toolCallBackground, "off");
  assert.equal(
    updateSetting(validOverride, "toolCallBackground", "border").toolCallBackground,
    "border",
  );
  assert.equal(settingsFrom({ wordEmphasis: "off" }, fallback).wordEmphasis, "off");
  assert.equal(
    settingsFrom({ toolCallBackground: "border" }, fallback).toolCallBackground,
    "border",
  );
  assert.deepEqual(settingsFrom({ tools: ["read", "grep"] }, fallback).tools, ["read", "grep"]);
  // Legacy value shapes (boolean toolCallBackground, CSV tools) are invalid, not coerced.
  assert.equal(
    settingsFrom({ toolCallBackground: true }, fallback).toolCallBackground,
    fallback.toolCallBackground,
  );
  assert.deepEqual(settingsFrom({ tools: "read,grep" }, fallback).tools, [...fallback.tools]);
});

test("settings recover valid siblings and expose bounded path-only diagnostics", () => {
  const fallback = {
    ...defaultCodePreviewSettings,
    shikiTheme: "github-dark",
    tools: ["write" as const],
  };
  const normalized = normalizeSettingsWithDiagnostics(
    {
      shikiTheme: "private-theme-token",
      readCollapsedLines: 19,
      tools: ["write", "private-tool"],
    },
    fallback,
  );
  assert.equal(normalized.settings.shikiTheme, "github-dark");
  assert.equal(normalized.settings.readCollapsedLines, 19);
  assert.deepEqual(normalized.settings.tools, ["write"]);
  assert.deepEqual(normalized.diagnostics, [
    { path: "settings.shikiTheme", issue: "invalid" },
    { path: "settings.tools", issue: "invalid" },
  ]);
  assert.equal(JSON.stringify(normalized.diagnostics).includes("private"), false);

  const bounded = normalizeSettingsWithDiagnostics(
    Object.fromEntries(CODE_PREVIEW_SETTING_KEYS.map((key) => [key, "private-value"])),
    fallback,
  );
  assert.equal(bounded.diagnostics.length, 16);
  assert.equal(JSON.stringify(bounded.diagnostics).includes("private-value"), false);
});

test("valid tool arrays are deduplicated and invalid arrays use the complete fallback", () => {
  const fallback = { ...defaultCodePreviewSettings, tools: ["write" as const] };
  assert.deepEqual(settingsFrom({ tools: ["grep", "read", "grep"] }, fallback).tools, [
    "read",
    "grep",
  ]);
  assert.deepEqual(settingsFrom({ tools: ["grep", "unknown"] }, fallback).tools, ["write"]);
});

test("setCodePreviewSettings publishes a new frozen snapshot", () => {
  const previous = { ...codePreviewSettings, tools: [...codePreviewSettings.tools] };
  const reference = codePreviewSettings;
  try {
    setCodePreviewSettings({
      ...defaultCodePreviewSettings,
      readCollapsedLines: 33,
      tools: ["bash"],
    });
    assert.notEqual(codePreviewSettings, reference);
    assert.equal(codePreviewSettings.readCollapsedLines, 33);
    assert.deepEqual(codePreviewSettings.tools, ["bash"]);
    assert.equal(Object.isFrozen(codePreviewSettings), true);
    assert.equal(Object.isFrozen(codePreviewSettings.tools), true);
  } finally {
    setCodePreviewSettings(previous);
  }
});

test("disabled preview settings keep corresponding tool renderers enabled", () => {
  const normalized = settingsFrom(
    {
      readContentPreview: false,
      writeContentPreview: false,
      editDiffPreview: false,
      bashResultPreview: false,
      grepResultPreview: false,
      findResultPreview: false,
      lsResultPreview: false,
      tools: [],
    },
    defaultCodePreviewSettings,
  );
  assert.deepEqual(normalized.tools, ["bash", "read", "write", "edit", "grep", "find", "ls"]);

  const withoutGrep = updateSetting(
    { ...normalized, tools: normalized.tools.filter((tool) => tool !== "grep") },
    "tool:grep",
    "off",
  );
  assert.ok(withoutGrep.tools.includes("grep"));
});

test("individual tool toggles update configured previews", () => {
  const withoutGrep = updateSetting(defaultCodePreviewSettings, "tool:grep", "off");
  assert.deepEqual(
    withoutGrep.tools,
    defaultCodePreviewSettings.tools.filter((tool) => tool !== "grep"),
  );

  const withGrep = updateSetting(withoutGrep, "tool:grep", "on");
  assert.deepEqual(withGrep.tools, defaultCodePreviewSettings.tools);
});
