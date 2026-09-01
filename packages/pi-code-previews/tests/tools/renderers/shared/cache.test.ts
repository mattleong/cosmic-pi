import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import {
  diffPreviewCacheKey,
  previewCacheKey,
  writeCallPreviewCacheKey,
} from "../../../../src/tools/renderers/shared/preview-cache-key";
import { codePreviewSettings, setCodePreviewSettings } from "../../../../src/config/state";
import { acquireProjectionOwnership } from "../../../../src/shared/projection-ownership";
import { clearSyntaxProjection, publishSyntaxProjection } from "../../../../src/syntax/projection";
import { cloneCodePreviewSettingsForTest, testTheme } from "../../../../tests/support/render";

const syntaxOwner = acquireProjectionOwnership("preview-cache-key-test");
let previousCodePreviewSettings = cloneCodePreviewSettingsForTest();

beforeEach(() => {
  previousCodePreviewSettings = cloneCodePreviewSettingsForTest();
});

afterEach(() => {
  clearSyntaxProjection(syntaxOwner);
  setCodePreviewSettings(previousCodePreviewSettings);
});

test("preview cache keys include word emphasis settings", () => {
  setCodePreviewSettings({ ...codePreviewSettings, wordEmphasis: "all" });
  const allKey = previewCacheKey("edit-result", "-1 old\n+1 new", "src/a.ts", false, testTheme());

  setCodePreviewSettings({ ...codePreviewSettings, wordEmphasis: "off" });
  const offKey = previewCacheKey("edit-result", "-1 old\n+1 new", "src/a.ts", false, testTheme());

  assert.notEqual(allKey, offKey);
});

test("diff preview cache keys change with syntax highlighter status", () => {
  const loadingKey = diffPreviewCacheKey(
    "edit-result",
    "-1 old\n+1 new",
    "src/a.ts",
    false,
    testTheme(),
    codePreviewSettings.editCollapsedLines,
  );

  publishSyntaxProjection(syntaxOwner, {
    generation: 1,
    theme: codePreviewSettings.shikiTheme,
    highlighter: undefined,
    loadedLanguages: ["typescript"],
    status: {
      initialized: true,
      loadedLanguages: 1,
      pendingLanguages: 0,
      statusVersion: 1,
    },
  });
  const readyKey = diffPreviewCacheKey(
    "edit-result",
    "-1 old\n+1 new",
    "src/a.ts",
    false,
    testTheme(),
    codePreviewSettings.editCollapsedLines,
  );

  assert.notEqual(loadingKey, readyKey);
});

test("write call cache keys include write-specific preview settings", () => {
  setCodePreviewSettings({ ...codePreviewSettings, writeCollapsedLines: 20 });
  const shortKey = writeCallPreviewCacheKey("const value = 1;", "src/a.ts", false, testTheme());

  setCodePreviewSettings({ ...codePreviewSettings, writeCollapsedLines: 40 });
  const longKey = writeCallPreviewCacheKey("const value = 1;", "src/a.ts", false, testTheme());

  assert.notEqual(shortKey, longKey);
});
