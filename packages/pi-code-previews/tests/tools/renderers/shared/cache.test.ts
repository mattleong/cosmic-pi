import assert from "node:assert/strict";
import { Text } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, test } from "vitest";
import { renderContextFixture } from "../../../../testing";
import { previewCacheKey } from "../../../../src/tools/renderers/shared/preview-cache-key";
import { cachedPreview } from "../../../../src/tools/renderers/shared/cache";
import type { RendererState } from "../../../../src/tools/renderers/shared/types";
import { defaultCodePreviewSettings } from "../../../../src/config/defaults";
import { codePreviewSettings, setCodePreviewSettings } from "../../../../src/config/state";
import { acquireProjectionOwnership } from "../../../../src/shared/projection-ownership";
import { clearSyntaxProjection } from "../../../../src/syntax/projection";
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
  const state: RendererState = {};
  const context = renderContextFixture({ args, state, argsComplete: false });
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
