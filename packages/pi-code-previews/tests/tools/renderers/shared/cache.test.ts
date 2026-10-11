import assert from "node:assert/strict";
import { Text } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, test } from "vitest";
import { renderContextFixture } from "../../../../testing";
import { previewCacheKey } from "../../../../src/tools/renderers/shared/preview-cache-key";
import { cachedPreview } from "../../../../src/tools/renderers/shared/cache";
import { defaultCodePreviewSettings } from "../../../../src/config/defaults";
import { codePreviewSettings, setCodePreviewSettings } from "../../../../src/config/state";
import { acquireProjectionOwnership } from "../../../../src/shared/projection-ownership";
import { clearSyntaxProjection, publishSyntaxProjection } from "../../../../src/syntax/projection";
import {
  builtinRenderers,
  plainTheme as theme,
  renderComponent,
  stripAnsi,
} from "../../../support/render";

let syntaxOwner = acquireProjectionOwnership("preview-cache-key-test");

beforeEach(() => {
  syntaxOwner = acquireProjectionOwnership("preview-cache-key-test");
  setCodePreviewSettings(defaultCodePreviewSettings);
});
afterEach(() => clearSyntaxProjection(syntaxOwner));

const key = () =>
  previewCacheKey(
    ["-1 old\n+1 new"],
    "src/a.ts",
    false,
    theme,
    codePreviewSettings.editCollapsedLines,
  );

function cachedReplacement(change: () => void) {
  const state = {};
  const render = () => cachedPreview(state, "preview", key(), () => new Text("preview"));
  const first = render();
  assert.equal(render(), first);
  change();
  const replacement = render();
  assert.equal(render(), replacement);
  return [first, replacement] as const;
}

test.each([
  { wordEmphasis: "off" },
  { editCollapsedLines: 40 },
  { shikiTheme: "github-light" },
  { syntaxHighlighting: false },
  { diffIntensity: "off" },
] as const)("settings %j replace the cached preview", (settings) => {
  assert.notEqual(
    ...cachedReplacement(() => setCodePreviewSettings({ ...codePreviewSettings, ...settings })),
  );
});

test.each(["initialized", "loadedLanguages", "pendingLanguages", "statusVersion"] as const)(
  "highlighter %s replaces the cached preview",
  (field) => {
    assert.notEqual(
      ...cachedReplacement(() =>
        publishSyntaxProjection(syntaxOwner, {
          theme: codePreviewSettings.shikiTheme,
          highlighter: undefined,
          loadedLanguages: [],
          failedThemes: [],
          failedLanguages: [],
          status: {
            initialized: false,
            loadedLanguages: 0,
            pendingLanguages: 0,
            statusVersion: 0,
            [field]: field === "initialized" ? true : 1,
          },
        }),
      ),
    );
  },
);

test("slots are independent and exact source, path, expansion and theme replace previews", () => {
  const state = {};
  const dependencies = previewCacheKey(["a\0b", "c"], "a.ts", false, theme, 20);
  const render = (slot: string, deps = dependencies) =>
    cachedPreview(state, slot, deps, () => new Text("preview"));
  const call = render("call");
  const result = render("result");
  assert.notEqual(call, result);
  for (const changed of [
    previewCacheKey(["a", "b\0c"], "a.ts", false, theme, 20),
    previewCacheKey(["a\0b", "c"], "b.ts", false, theme, 20),
    previewCacheKey(["a\0b", "c"], "a.ts", true, theme, 20),
    previewCacheKey(["a\0b", "c"], "a.ts", false, new Proxy(theme, {}), 20),
    previewCacheKey(["a\0b", "c", ""], "a.ts", false, theme, 20),
  ]) {
    const current = render("call");
    const changedPreview = render("call", changed);
    assert.notEqual(changedPreview, current);
    assert.equal(render("call", changed), changedPreview);
    assert.equal(render("result"), result);
  }
});

test("edit previews wait for complete arguments and replace changed content", () => {
  setCodePreviewSettings({ ...codePreviewSettings, syntaxHighlighting: false });
  const edit = builtinRenderers("edit")!;
  const args = { path: "src/a.ts", edits: [{ oldText: "old", newText: "new" }] };
  const context = renderContextFixture({ args, argsComplete: false });
  assert.doesNotMatch(renderComponent(edit.renderCall!(args, theme, context)), /\bnew\b/);
  context.argsComplete = true;
  const complete = stripAnsi(renderComponent(edit.renderCall!(args, theme, context)));
  assert.match(complete, /\bnew\b/);
  assert.equal(
    stripAnsi(renderComponent(edit.renderCall!(structuredClone(args), theme, context))),
    complete,
  );
  const changed = { path: "src/b.ts", edits: [{ oldText: "old", newText: "replacement" }] };
  const rendered = stripAnsi(renderComponent(edit.renderCall!(changed, theme, context)));
  assert.match(rendered, /b\.ts/);
  assert.match(rendered, /replacement/);
  assert.doesNotMatch(rendered, /\bnew\b/);

  // A result summary stays with its arguments; a changed path or edit drops it.
  context.state.editSummaryText = "retained-summary";
  assert.match(renderComponent(edit.renderCall!(changed, theme, context)), /retained-summary/);
  const moved = { ...changed, path: "src/c.ts" };
  const rewritten = { ...moved, edits: [{ oldText: "old", newText: "other" }] };
  for (const next of [moved, rewritten]) {
    context.state.editSummaryText = "retained-summary";
    assert.doesNotMatch(
      renderComponent(edit.renderCall!(next, theme, context)),
      /retained-summary/,
    );
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
  const context = renderContextFixture({ args });
  const shownRows = () =>
    renderComponent(write.renderCall!(args, theme, context)).match(/\brow\d+\b/g)?.length ?? 0;
  const collapsed = shownRows();
  assert.equal(shownRows(), collapsed);
  setCodePreviewSettings({ ...codePreviewSettings, writeCollapsedLines: 30 });
  assert.ok(shownRows() > collapsed);
});
