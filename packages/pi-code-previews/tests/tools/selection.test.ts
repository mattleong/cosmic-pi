import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";
import { applyPresentationSettings } from "../../testing";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { setCodePreviewSettings } from "../../src/config/state";
import { getEnabledCodePreviewTools } from "../../src/tools/selection";

beforeEach(() => applyPresentationSettings({}));

test("native tool search is selected by default and can be excluded independently", () => {
  assert.ok(getEnabledCodePreviewTools().has("tool_search"));
  setCodePreviewSettings({ ...defaultCodePreviewSettings, tools: ["codemode"] });
  assert.equal(getEnabledCodePreviewTools().has("tool_search"), false);
  setCodePreviewSettings({ ...defaultCodePreviewSettings, tools: ["tool_search"] });
  assert.deepEqual([...getEnabledCodePreviewTools()], ["tool_search"]);
});

test("settings select enabled renderers", () => {
  setCodePreviewSettings({ ...defaultCodePreviewSettings, tools: ["bash", "write", "edit"] });
  assert.deepEqual([...getEnabledCodePreviewTools()], ["bash", "write", "edit"]);
});

test("disabled preview settings force the renderers that hide those previews", () => {
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    writeContentPreview: false,
    editDiffPreview: false,
    grepResultPreview: false,
    findResultPreview: false,
    lsResultPreview: false,
    tools: [],
  });
  assert.deepEqual(
    [...getEnabledCodePreviewTools()],
    ["write", "edit", "grep", "find", "ls", "bash"],
  );
});
