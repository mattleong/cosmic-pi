import assert from "node:assert/strict";
import type { EditToolInput } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, test } from "vitest";
import { renderContextFixture } from "../../../../testing";
import { previewCacheKey } from "../../../../src/tools/renderers/shared/preview-cache-key";
import { cachedPreview } from "../../../../src/tools/renderers/shared/cache";
import type {
  RendererState,
  ToolRenderContext,
} from "../../../../src/tools/renderers/shared/types";
import { defaultCodePreviewSettings } from "../../../../src/config/defaults";
import { codePreviewSettings, setCodePreviewSettings } from "../../../../src/config/state";
import { acquireProjectionOwnership } from "../../../../src/shared/projection-ownership";
import { clearSyntaxProjection, publishSyntaxProjection } from "../../../../src/syntax/projection";
import { builtinRenderers, plainTheme as theme, renderComponent } from "../../../support/render";

const syntaxOwner = acquireProjectionOwnership("preview-cache-key-test");

beforeEach(() => setCodePreviewSettings(defaultCodePreviewSettings));
afterEach(() => clearSyntaxProjection(syntaxOwner));

test.each([
  ["word emphasis", () => setCodePreviewSettings({ ...codePreviewSettings, wordEmphasis: "off" })],
  [
    "collapsed line",
    () => setCodePreviewSettings({ ...codePreviewSettings, editCollapsedLines: 40 }),
  ],
  [
    "syntax highlighter status",
    () =>
      publishSyntaxProjection(syntaxOwner, {
        theme: codePreviewSettings.shikiTheme,
        highlighter: undefined,
        loadedLanguages: ["typescript"],
        failedThemes: [],
        failedLanguages: [],
        status: { initialized: true, loadedLanguages: 1, pendingLanguages: 0, statusVersion: 1 },
      }),
  ],
] as const)("%s changes replace the cached preview", (_, change) => {
  const state: RendererState = {};
  const render = () =>
    cachedPreview(
      state,
      "key",
      "component",
      previewCacheKey(
        "edit-result",
        "-1 old\n+1 new",
        "src/a.ts",
        false,
        theme,
        codePreviewSettings.editCollapsedLines,
      ),
      () => new Text("preview"),
    );
  const first = render();
  assert.equal(render(), first);
  change();
  const replacement = render();
  assert.notEqual(replacement, first);
  assert.equal(render(), replacement);
});

test("edit previews wait for complete arguments and reuse unchanged arguments", () => {
  setCodePreviewSettings({
    ...codePreviewSettings,
    syntaxHighlighting: false,
    toolCallBackground: "off",
    toolCallTiming: false,
  });
  const edit = builtinRenderers("edit")!;
  const args: EditToolInput = { path: "src/a.ts", edits: [{ oldText: "old", newText: "new" }] };
  const context: ToolRenderContext<RendererState, EditToolInput> = renderContextFixture({
    args,
    argsComplete: false,
  });
  renderComponent(edit.renderCall!(args, theme, context));
  assert.equal(context.state.editCallPreviewComponent, undefined);
  context.argsComplete = true;
  renderComponent(edit.renderCall!(args, theme, context));
  const preview = context.state.editCallPreviewComponent;
  assert.ok(preview);
  renderComponent(
    edit.renderCall!(
      { ...args, edits: args.edits.map((operation) => ({ ...operation })) },
      theme,
      context,
    ),
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
    assert.notEqual(context.state.editCallPreviewComponent, preview);
  }
});

test("write collapsed line changes replace the cached write preview", () => {
  setCodePreviewSettings({
    ...codePreviewSettings,
    writeContentPreview: true,
    writeCollapsedLines: 20,
    syntaxHighlighting: false,
    toolCallBackground: "off",
    toolCallTiming: false,
  });
  const write = builtinRenderers("write")!;
  const content = Array.from({ length: 40 }, (_, index) => `row${index + 1}`).join("\n");
  const args = { path: "src/a.ts", content };
  const context: ToolRenderContext<RendererState, typeof args> = renderContextFixture({ args });
  const shownRows = () =>
    renderComponent(write.renderCall!(args, theme, context)).match(/\brow\d+\b/g)?.length ?? 0;
  const collapsed = shownRows();
  const preview = context.state.writeCallPreviewComponent;
  assert.ok(preview);
  assert.equal(shownRows(), collapsed);
  assert.equal(context.state.writeCallPreviewComponent, preview);
  setCodePreviewSettings({ ...codePreviewSettings, writeCollapsedLines: 30 });
  assert.ok(shownRows() > collapsed);
  assert.notEqual(context.state.writeCallPreviewComponent, preview);
});
