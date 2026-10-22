import assert from "node:assert/strict";
import type { JsonObject } from "pi-cosmic-core";
import { test } from "vitest";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { CODE_PREVIEW_SETTING_KEYS, type CodePreviewSettings } from "../../src/config/schema";
import { codePreviewSettings } from "../../src/config/state";
import { normalizeSettingsWithDiagnostics, updateSetting } from "../../src/config/values";

const settingsFrom = (
  data: JsonObject,
  fallback: CodePreviewSettings = codePreviewSettings,
): CodePreviewSettings => normalizeSettingsWithDiagnostics(data, fallback).settings;

test("settings recover valid siblings and expose bounded path-only diagnostics", () => {
  const fallback: CodePreviewSettings = {
    ...defaultCodePreviewSettings,
    shikiTheme: "github-dark",
    toolCallCollapsedStyle: "compact",
    tools: ["write"],
  };
  const normalized = normalizeSettingsWithDiagnostics(
    {
      shikiTheme: "private-theme-token",
      toolCallCollapsedStyle: "private-style-token",
      readCollapsedLines: 19,
      tools: ["read", "private-tool", "grep"],
    },
    fallback,
  );
  assert.equal(normalized.settings.shikiTheme, "github-dark");
  assert.equal(normalized.settings.toolCallCollapsedStyle, "compact");
  assert.equal(normalized.settings.readCollapsedLines, 19);
  assert.deepEqual(normalized.settings.tools, ["read", "grep"]);
  assert.deepEqual(normalized.diagnostics, [
    { path: "settings.shikiTheme", issue: "invalid" },
    { path: "settings.toolCallCollapsedStyle", issue: "invalid" },
    { path: "settings.tools[1]", issue: "invalid" },
  ]);
  assert.equal(JSON.stringify(normalized.diagnostics).includes("private"), false);

  const bounded = normalizeSettingsWithDiagnostics(
    Object.fromEntries(CODE_PREVIEW_SETTING_KEYS.map((key) => [key, "private-value"])),
    fallback,
  );
  assert.equal(bounded.diagnostics.length, 16);
  assert.equal(JSON.stringify(bounded.diagnostics).includes("private-value"), false);
});

test("tool selections keep known names instead of falling back to every tool", () => {
  const normalized = normalizeSettingsWithDiagnostics(
    { tools: ["write", "Edit", 7] },
    defaultCodePreviewSettings,
  );
  assert.deepEqual(normalized.settings.tools, ["write"]);
  assert.deepEqual(normalized.diagnostics, [
    { path: "settings.tools[1]", issue: "invalid" },
    { path: "settings.tools[2]", issue: "invalid" },
  ]);

  const fallback: CodePreviewSettings = { ...defaultCodePreviewSettings, tools: ["grep"] };
  assert.deepEqual(settingsFrom({ tools: [] }, fallback).tools, []);
  assert.deepEqual(settingsFrom({ tools: ["Edit"] }, fallback).tools, ["grep"]);
  assert.deepEqual(normalizeSettingsWithDiagnostics({ tools: "write" }, fallback).diagnostics, [
    { path: "settings.tools", issue: "invalid" },
  ]);
});

test("turning a preview off and on again leaves the saved tool selection unchanged", () => {
  const normalized = settingsFrom(
    { readContentPreview: false, tools: ["grep"] },
    defaultCodePreviewSettings,
  );
  assert.deepEqual(normalized.tools, ["grep"]);
  const off = updateSetting(normalized, "readContentPreview", "off");
  assert.deepEqual(updateSetting(off, "readContentPreview", "on").tools, ["grep"]);
  assert.deepEqual(updateSetting({ ...off, tools: ["grep", "read"] }, "tools", "grep").tools, [
    "grep",
  ]);
});
