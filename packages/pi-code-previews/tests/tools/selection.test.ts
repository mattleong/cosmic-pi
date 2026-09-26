// Test/benchmark boundary intentionally exercises native Pi, Node, Promise, timer, and environment APIs.
import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";
import { applyPresentationSettings } from "../../testing";
import {
  codePreviewPerformanceConfig,
  codePreviewToolsEnvironmentValue,
  publishCodePreviewEnvironmentProjection,
} from "../../src/config/env";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { setCodePreviewSettings } from "../../src/config/state";
import { getEnabledCodePreviewTools } from "../../src/tools/selection";

const publishCodePreviewToolsEnvironment = (value: string | undefined): void => {
  publishCodePreviewEnvironmentProjection(codePreviewPerformanceConfig, value);
};

beforeEach(() => {
  const restoreSettings = applyPresentationSettings({});
  const previousTools = codePreviewToolsEnvironmentValue;
  return () => {
    restoreSettings();
    publishCodePreviewToolsEnvironment(previousTools);
  };
});

test("settings select enabled renderers when CODE_PREVIEW_TOOLS is unset", () => {
  publishCodePreviewToolsEnvironment(undefined);
  setCodePreviewSettings({ ...defaultCodePreviewSettings, tools: ["bash", "write", "edit"] });
  assert.deepEqual([...getEnabledCodePreviewTools()], ["bash", "write", "edit"]);
});

test("CODE_PREVIEW_TOOLS overrides configured renderer settings", () => {
  setCodePreviewSettings({ ...defaultCodePreviewSettings, tools: ["bash", "write", "edit"] });
  publishCodePreviewToolsEnvironment("write,edit,grep");
  assert.deepEqual([...getEnabledCodePreviewTools()], ["write", "edit", "grep"]);
});

test("invalid CODE_PREVIEW_TOOLS values fall back to configured renderers", () => {
  setCodePreviewSettings({ ...defaultCodePreviewSettings, tools: ["bash", "read"] });
  publishCodePreviewToolsEnvironment("gred");

  assert.deepEqual([...getEnabledCodePreviewTools()], ["bash", "read"]);
});

test("disabled preview settings force required renderers even with CODE_PREVIEW_TOOLS", () => {
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    writeContentPreview: false,
    editDiffPreview: false,
    grepResultPreview: false,
    findResultPreview: false,
    lsResultPreview: false,
    tools: [],
  });
  publishCodePreviewToolsEnvironment("none");
  assert.deepEqual(
    [...getEnabledCodePreviewTools()],
    ["write", "edit", "grep", "find", "ls", "bash"],
  );
});
