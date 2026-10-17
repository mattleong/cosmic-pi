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
