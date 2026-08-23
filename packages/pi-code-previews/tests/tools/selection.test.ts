// Test/benchmark boundary intentionally exercises native Pi, Node, Promise, timer, and environment APIs.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import {
  codePreviewPerformanceConfig,
  codePreviewToolsEnvironmentValue,
  publishCodePreviewEnvironmentProjection,
} from "../../src/config/env";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { codePreviewSettings, setCodePreviewSettings } from "../../src/config/state";
import {
  formatEnabledCodePreviewTools,
  getEnabledCodePreviewTools,
} from "../../src/tools/selection";

const publishCodePreviewToolsEnvironment = (value: string | undefined): void => {
  publishCodePreviewEnvironmentProjection(codePreviewPerformanceConfig, value);
};

let previousCodePreviewSettings = { ...codePreviewSettings };
let previousCodePreviewTools: string | undefined;

beforeEach(() => {
  previousCodePreviewSettings = { ...codePreviewSettings };
  previousCodePreviewTools = codePreviewToolsEnvironmentValue;
});

afterEach(() => {
  setCodePreviewSettings(previousCodePreviewSettings);
  publishCodePreviewToolsEnvironment(previousCodePreviewTools);
});

test("CODE_PREVIEW_TOOLS selects enabled renderers", () => {
  publishCodePreviewToolsEnvironment("write,edit,grep");
  assert.deepEqual([...getEnabledCodePreviewTools()], ["write", "edit", "grep"]);
  assert.equal(formatEnabledCodePreviewTools(), "write, edit, grep");
});

test("publishing CODE_PREVIEW_TOOLS preserves performance projection values", () => {
  const previousPerformance = codePreviewPerformanceConfig;
  const customPerformance = { ...previousPerformance, cacheLimit: 7 };
  publishCodePreviewEnvironmentProjection(customPerformance, undefined);
  try {
    publishCodePreviewToolsEnvironment("grep");
    assert.equal(codePreviewPerformanceConfig.cacheLimit, 7);
  } finally {
    publishCodePreviewEnvironmentProjection(previousPerformance, previousCodePreviewTools);
  }
});

test("settings select enabled renderers when CODE_PREVIEW_TOOLS is unset", () => {
  publishCodePreviewToolsEnvironment(undefined);
  setCodePreviewSettings({ ...defaultCodePreviewSettings, tools: ["bash", "write", "edit"] });
  assert.deepEqual([...getEnabledCodePreviewTools()], ["bash", "write", "edit"]);
  assert.equal(formatEnabledCodePreviewTools(), "bash, write, edit");
});

test("CODE_PREVIEW_TOOLS overrides configured renderer settings", () => {
  setCodePreviewSettings({ ...defaultCodePreviewSettings, tools: ["bash", "write", "edit"] });
  publishCodePreviewToolsEnvironment("grep");
  assert.deepEqual([...getEnabledCodePreviewTools()], ["grep"]);
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
