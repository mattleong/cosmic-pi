import assert from "node:assert/strict";
import { test } from "vitest";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { CODE_PREVIEW_SETTING_KEYS, type CodePreviewSettings } from "../../src/config/schema";
import { codePreviewSettings } from "../../src/config/state";
import { normalizeSettingsWithDiagnostics, updateSetting } from "../../src/config/values";

type SettingsFixtureValue = string | number | boolean | readonly string[] | undefined;

const settingsFrom = (
  data: Readonly<Record<string, SettingsFixtureValue>>,
  fallback: CodePreviewSettings = codePreviewSettings,
): CodePreviewSettings => normalizeSettingsWithDiagnostics(data, fallback).settings;

const disabledFlags = {
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
} as const;

test("settings normalization and reset preserve defaults", () => {
  const normalized = settingsFrom({
    ...disabledFlags,
    readCollapsedLines: -1,
    toolCallBackground: "off",
    toolCallCollapsedStyle: "compact",
    tools: ["bash", "not-a-tool", "write", "bash"],
  });
  // Disabled previews keep every tool renderer; invalid values keep their defaults.
  assert.deepEqual(normalized, {
    ...defaultCodePreviewSettings,
    ...disabledFlags,
    toolCallBackground: "off",
    toolCallCollapsedStyle: "compact",
  });
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
  // SAFETY: disabledFlags is a literal object whose own keys are exactly its declared keys.
  for (const key of Object.keys(disabledFlags) as Array<keyof typeof disabledFlags>)
    assert.equal(updateSetting(validOverride, key, "off")[key], false, key);
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
    toolCallCollapsedStyle: "compact" as const,
    tools: ["write" as const],
  };
  const normalized = normalizeSettingsWithDiagnostics(
    {
      shikiTheme: "private-theme-token",
      toolCallCollapsedStyle: "private-style-token",
      readCollapsedLines: 19,
      tools: ["write", "private-tool"],
    },
    fallback,
  );
  assert.equal(normalized.settings.shikiTheme, "github-dark");
  assert.equal(normalized.settings.toolCallCollapsedStyle, "compact");
  assert.equal(normalized.settings.readCollapsedLines, 19);
  assert.deepEqual(normalized.settings.tools, ["write"]);
  assert.deepEqual(normalized.diagnostics, [
    { path: "settings.shikiTheme", issue: "invalid" },
    { path: "settings.toolCallCollapsedStyle", issue: "invalid" },
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

test("compact style edits leave background, timing, preview limits, and tool selection alone", () => {
  const current: CodePreviewSettings = {
    ...defaultCodePreviewSettings,
    toolCallBackground: "border",
    toolCallTiming: false,
    readCollapsedLines: 40,
    tools: ["read"],
  };
  const compact = updateSetting(current, "toolCallCollapsedStyle", "compact");
  assert.deepEqual(compact, { ...current, toolCallCollapsedStyle: "compact" });
  assert.deepEqual(updateSetting(compact, "toolCallCollapsedStyle", "invalid"), compact);
  assert.deepEqual(updateSetting(compact, "toolCallCollapsedStyle", "preview"), current);
  assert.deepEqual(
    updateSetting(compact, "resetToDefaults", "reset now"),
    defaultCodePreviewSettings,
  );
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
