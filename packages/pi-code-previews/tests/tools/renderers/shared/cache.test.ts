import assert from "node:assert/strict";
import type { EditToolInput } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, test } from "vitest";
import { applyPresentationSettings, renderContextFixture } from "../../../../testing";
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
import { plainTheme as theme, renderComponent } from "../../../support/render";

const syntaxOwner = acquireProjectionOwnership("preview-cache-key-test");

beforeEach(() => applyPresentationSettings({}));
afterEach(() => clearSyntaxProjection(syntaxOwner));

/** Reports whether a render is reused, replaced after `change`, and the replacement reused. */
function cacheTransitions(key: () => string, change: () => void): boolean[] {
  const state: RendererState = {};
  const render = () => cachedPreview(state, "key", "component", key(), () => new Text("preview"));
  const first = render();
  const reused = render() === first;
  change();
  const replacement = render();
  return [reused, replacement !== first, render() === replacement];
}

test("word emphasis changes replace the cached preview", () => {
  setCodePreviewSettings({ ...codePreviewSettings, wordEmphasis: "all" });
  const transitions = cacheTransitions(
    () => previewCacheKey("edit-result", "-1 old\n+1 new", "src/a.ts", false, theme),
    () => setCodePreviewSettings({ ...codePreviewSettings, wordEmphasis: "off" }),
  );
  assert.deepEqual(transitions, [true, true, true]);
});

test("syntax highlighter status changes replace the cached diff preview", () => {
  const transitions = cacheTransitions(
    () =>
      diffPreviewCacheKey(
        "edit-result",
        "-1 old\n+1 new",
        "src/a.ts",
        false,
        theme,
        codePreviewSettings.editCollapsedLines,
      ),
    () =>
      publishSyntaxProjection(syntaxOwner, {
        theme: codePreviewSettings.shikiTheme,
        highlighter: undefined,
        loadedLanguages: ["typescript"],
        failedThemes: [],
        failedLanguages: [],
        status: { initialized: true, loadedLanguages: 1, pendingLanguages: 0, statusVersion: 1 },
      }),
  );
  assert.deepEqual(transitions, [true, true, true]);
});

test("write collapsed line changes replace the cached write preview", () => {
  setCodePreviewSettings({ ...codePreviewSettings, writeCollapsedLines: 20 });
  const transitions = cacheTransitions(
    () => writeCallPreviewCacheKey("const value = 1;", "src/a.ts", false, theme),
    () => setCodePreviewSettings({ ...codePreviewSettings, writeCollapsedLines: 40 }),
  );
  assert.deepEqual(transitions, [true, true, true]);
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
  const args: EditToolInput = { path: "src/a.ts", edits: [{ oldText: "old", newText: "new" }] };
  const context: ToolRenderContext<RendererState, EditToolInput> = renderContextFixture({
    args,
    argsComplete: false,
  });
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
