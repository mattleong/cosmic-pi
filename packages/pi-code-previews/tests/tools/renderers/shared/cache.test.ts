import assert from "node:assert/strict";
import type { EditToolInput } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, test } from "vitest";
import {
  diffPreviewCacheKey,
  previewCacheKey,
  writeCallPreviewCacheKey,
} from "../../../../src/tools/renderers/shared/preview-cache-key";
import { cachedPreview } from "../../../../src/tools/renderers/shared/cache";
import { createEditPreviewTool } from "../../../../src/tools/renderers/edit";
import type {
  RendererState,
  ToolRenderContext,
} from "../../../../src/tools/renderers/shared/types";
import { codePreviewSettings, setCodePreviewSettings } from "../../../../src/config/state";
import { acquireProjectionOwnership } from "../../../../src/shared/projection-ownership";
import { clearSyntaxProjection, publishSyntaxProjection } from "../../../../src/syntax/projection";
import {
  cloneCodePreviewSettingsForTest,
  renderComponent,
  testTheme,
} from "../../../support/render";

const syntaxOwner = acquireProjectionOwnership("preview-cache-key-test");
let previousCodePreviewSettings = cloneCodePreviewSettingsForTest();

beforeEach(() => {
  previousCodePreviewSettings = cloneCodePreviewSettingsForTest();
});

afterEach(() => {
  clearSyntaxProjection(syntaxOwner);
  setCodePreviewSettings(previousCodePreviewSettings);
});

function previewCache(key: () => string) {
  const state: RendererState = {};
  return () => cachedPreview(state, "key", "component", key(), () => new Text("preview"));
}

test("word emphasis changes replace the cached preview", () => {
  const theme = testTheme();
  setCodePreviewSettings({ ...codePreviewSettings, wordEmphasis: "all" });
  const render = previewCache(() =>
    previewCacheKey("edit-result", "-1 old\n+1 new", "src/a.ts", false, theme),
  );
  const first = render();
  assert.equal(render(), first);
  setCodePreviewSettings({ ...codePreviewSettings, wordEmphasis: "off" });
  const replacement = render();
  assert.notEqual(replacement, first);
  assert.equal(render(), replacement);
});

test("syntax highlighter status changes replace the cached diff preview", () => {
  const theme = testTheme();
  const render = previewCache(() =>
    diffPreviewCacheKey(
      "edit-result",
      "-1 old\n+1 new",
      "src/a.ts",
      false,
      theme,
      codePreviewSettings.editCollapsedLines,
    ),
  );
  const first = render();
  assert.equal(render(), first);
  publishSyntaxProjection(syntaxOwner, {
    generation: 1,
    theme: codePreviewSettings.shikiTheme,
    highlighter: undefined,
    loadedLanguages: ["typescript"],
    status: { initialized: true, loadedLanguages: 1, pendingLanguages: 0, statusVersion: 1 },
  });
  const replacement = render();
  assert.notEqual(replacement, first);
  assert.equal(render(), replacement);
});

test("write collapsed line changes replace the cached write preview", () => {
  const theme = testTheme();
  setCodePreviewSettings({ ...codePreviewSettings, writeCollapsedLines: 20 });
  const render = previewCache(() =>
    writeCallPreviewCacheKey("const value = 1;", "src/a.ts", false, theme),
  );
  const first = render();
  assert.equal(render(), first);
  setCodePreviewSettings({ ...codePreviewSettings, writeCollapsedLines: 40 });
  const replacement = render();
  assert.notEqual(replacement, first);
  assert.equal(render(), replacement);
});

test("edit previews wait for complete arguments and reuse unchanged arguments", () => {
  setCodePreviewSettings({
    ...codePreviewSettings,
    editDiffPreview: true,
    syntaxHighlighting: false,
    toolCallBackground: "off",
    toolCallTiming: false,
  });
  const edit = createEditPreviewTool("/project");
  const theme = testTheme();
  const args: EditToolInput = { path: "src/a.ts", edits: [{ oldText: "old", newText: "new" }] };
  const context: ToolRenderContext<RendererState, EditToolInput> = {
    args,
    state: {},
    toolCallId: "edit",
    cwd: "/project",
    invalidate: () => undefined,
    lastComponent: undefined,
    executionStarted: false,
    argsComplete: false,
    isPartial: true,
    expanded: false,
    showImages: true,
    isError: false,
  };
  edit.renderCall!(args, theme, context);
  assert.equal(context.state.editCallPreviewComponent, undefined);
  context.argsComplete = true;
  edit.renderCall!(args, theme, context);
  const preview = context.state.editCallPreviewComponent;
  assert.ok(preview);
  edit.renderCall!(
    { ...args, edits: args.edits.map((operation) => ({ ...operation })) },
    theme,
    context,
  );
  assert.equal(context.state.editCallPreviewComponent, preview);

  context.executionStarted = true;
  context.state.editSummaryText = "retained-summary";
  assert.match(renderComponent(edit.renderCall!(args, theme, context)), /retained-summary/);
  for (const changed of [
    { ...args, path: "src/b.ts" },
    { ...args, path: "src/b.ts", edits: [{ oldText: "old", newText: "NEW" }] },
  ]) {
    context.state.editSummaryText = "retained-summary";
    assert.doesNotMatch(
      renderComponent(edit.renderCall!(changed, theme, context)),
      /retained-summary/,
    );
    assert.equal(context.state.editCallPreviewComponent, undefined);
  }
});
