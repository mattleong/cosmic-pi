import assert from "node:assert/strict";
import {
  generateDiffString,
  initTheme,
  type AgentToolResult,
  type ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, beforeAll, test } from "vitest";
import { failingTheme, macrotask } from "pi-cosmic-core/testing";
import { hostToolRow, renderContextFixture } from "../../../testing";
import { defaultCodePreviewSettings } from "../../../src/config/defaults";
import type { CodePreviewSettings } from "../../../src/config/schema";
import { setCodePreviewSettings } from "../../../src/config/state";
import { ALL_CODE_PREVIEW_TOOLS } from "../../../src/tools/names";
import { builtinRenderers, renderComponent, stripAnsi } from "../../support/render";
import { editPreviewRenderers } from "../../../src/tools/renderers/edit";
import { writePreviewRenderers } from "../../../src/tools/renderers/write";

beforeAll(() => initTheme("dark", false));
afterEach(() => setCodePreviewSettings(defaultCodePreviewSettings));

type RowArguments =
  | { readonly path: string; readonly content: string }
  | {
      readonly path: string;
      readonly edits: ReadonlyArray<{ readonly oldText: string; readonly newText: string }>;
    };

function liveRow(
  name: "write" | "edit",
  args: RowArguments,
  settings: Partial<CodePreviewSettings> = {},
) {
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    syntaxHighlighting: false,
    toolCallTiming: false,
    toolCallCollapsedStyle: "preview",
    tools: [...ALL_CODE_PREVIEW_TOOLS],
    ...settings,
  });
  const renderers = builtinRenderers(name);
  const row = hostToolRow(name, args, renderers, { id: `${name}-call` });
  row.setArgsComplete();
  return row;
}

const text = (row: ToolExecutionComponent) => stripAnsi(row.render(120).join("\n"));
const count = (value: string, pattern: RegExp) => value.match(pattern)?.length ?? 0;

const result = <Details>(
  output: string,
  details: Details,
  isError = false,
): AgentToolResult<Details> & { isError: boolean } => ({
  content: [{ type: "text", text: output }],
  details,
  isError,
});

const before = `${Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n")}\n`;
const content = before.replace("line 10\n", "LINE 10\n");
const overwrite = result("Successfully wrote to a.txt", {
  codePreviewBeforeWrite: { kind: "content", content: before },
});

test("a finished write shows its diff once, and its content when no diff is shown", () => {
  const row = liveRow("write", { path: "/project/a.txt", content });
  assert.match(text(row), /line 0\b/u);
  row.markExecutionStarted();
  assert.match(text(row), /line 0\b/u);
  row.updateResult(overwrite);
  const settled = text(row);
  assert.equal(count(settled, /LINE 10/gu), 1);
  assert.doesNotMatch(settled, /line 0\b/u);
  row.setExpanded(true);
  assert.match(text(row), /line 0\b/u);

  for (const withoutDiff of [
    result("EACCES: permission denied, open '/project/a.txt'", undefined, true),
    result("Successfully wrote to a.txt", {}),
    result("Successfully wrote to a.txt", { codePreviewBeforeWrite: undefined }),
  ]) {
    const other = liveRow("write", { path: "/project/a.txt", content });
    other.markExecutionStarted();
    other.updateResult(withoutDiff);
    assert.match(text(other), /line 0\b/u);
  }
});

test("a replayed diff-skip reason cannot write terminal control sequences", () => {
  const row = liveRow("write", { path: "/project/a.txt", content: "next" });
  row.updateResult(
    result("Successfully wrote to a.txt", {
      codePreviewBeforeWrite: {
        kind: "skipped",
        reason: "previous file too large\u001b]0;title\u0007",
        byteLength: 300_000,
        maxBytes: 200_000,
        sizeExceeded: true,
      },
    }),
  );
  for (const expanded of [false, true]) {
    row.setExpanded(expanded);
    assert.equal(row.render(120).join("\n").includes("\u001b]0;title"), false);
  }
});

const edit = { path: "/project/a.ts", edits: [{ oldText: "alpha\nbeta", newText: "alpha\nBETA" }] };

test("an edit keeps its proposal until the applied diff replaces it", () => {
  const row = liveRow("edit", edit);
  assert.match(text(row), /BETA/u);
  row.markExecutionStarted();
  assert.match(text(row), /BETA/u);
  row.updateResult(
    result("Successfully replaced text in /project/a.ts.", {
      diff: generateDiffString("alpha\nbeta\n", "alpha\nBETA\n").diff,
    }),
  );
  assert.equal(count(text(row), /BETA/gu), 1);
  row.setExpanded(true);
  assert.equal(count(text(row), /BETA/gu), 2);

  const failed = liveRow("edit", edit);
  failed.markExecutionStarted();
  failed.updateResult(result("Could not find the exact text in /project/a.ts.", undefined, true));
  assert.match(text(failed), /BETA/u);
});

test("NUL-containing edits cannot reuse a different proposal", () => {
  const first = { path: "/project/a.ts", edits: [{ oldText: "a\0b", newText: "c" }] };
  const next = { ...first, edits: [{ oldText: "a", newText: "b\0c" }] };
  const row = liveRow("edit", first);
  const obsolete = text(row);
  row.updateArgs(next);
  row.setArgsComplete();
  const updated = text(row);
  assert.notEqual(updated, obsolete);
  assert.equal(updated, text(liveRow("edit", next)));
  row.setExpanded(true);
  const fresh = liveRow("edit", next);
  fresh.setExpanded(true);
  assert.equal(text(row), text(fresh));
});

test.each([
  ["edit", editPreviewRenderers, edit, /no diff/u],
  ["write", writePreviewRenderers, { path: "/project/a.ts", content }, /new file/u],
] as const)(
  "%s retained headings read results while keeping their captured arguments",
  (_, factory, args, marker) => {
    setCodePreviewSettings({
      ...defaultCodePreviewSettings,
      writeContentPreview: false,
      editDiffPreview: false,
    });
    let drawing = false;
    const theme = failingTheme({ when: () => drawing });
    const renderer = factory("/project");
    const context = renderContextFixture<{ readonly path: string }>({ args, isPartial: false });
    const retained = renderer.renderCall(args, theme, context);
    assert.doesNotMatch(renderComponent(retained), marker);
    context.args = { ...args, path: "/project/b.ts" };
    const latest = renderer.renderCall(context.args, theme, context);
    const options = { expanded: false, isPartial: false };
    renderer.renderResult(
      result("done", { codePreviewBeforeWrite: undefined }),
      options,
      theme,
      context,
    );
    drawing = true;
    retained.invalidate();
    assert.match(renderComponent(retained), /a\.ts/u);
    assert.doesNotMatch(renderComponent(retained), /b\.ts/u);
    for (const heading of [retained, latest]) assert.match(renderComponent(heading), marker);
    drawing = false;
    renderer.renderResult(result("failed", undefined), options, theme, {
      ...context,
      isError: true,
    });
    drawing = true;
    for (const heading of [retained, latest]) assert.doesNotMatch(renderComponent(heading), marker);
  },
);

it.effect.each([
  {
    name: "edit",
    argsAt: (size: number): RowArguments => ({
      path: "/project/a.ts",
      edits: [{ oldText: "a", newText: "b".repeat(size) }],
    }),
  },
  {
    name: "write",
    argsAt: (size: number): RowArguments => ({ path: "/project/a.ts", content: "c".repeat(size) }),
  },
] as const)("a $name row releases the render contexts of replaced arguments", ({ name, argsAt }) =>
  Effect.gen(function* () {
    const collectGarbage = globalThis.gc;
    assert.ok(collectGarbage, "vitest.config.ts starts test workers with --expose-gc");
    let first: RowArguments | undefined = argsAt(1);
    const released = new WeakRef(first);
    const row = liveRow(name, first);
    first = undefined;
    for (let size = 2; size <= 20; size++) {
      row.updateArgs(argsAt(size));
      row.render(120);
    }
    yield* macrotask;
    collectGarbage();
    assert.equal(released.deref(), undefined);
    assert.match(text(row), /a\.ts/u);
  }),
);

test("a proposed edit does not number its rows as file lines", () => {
  const changed = text(liveRow("edit", edit))
    .split("\n")
    .filter((line) => line.includes("BETA") || line.includes("beta"));
  assert.equal(changed.length, 2);
  for (const line of changed) assert.doesNotMatch(line, /\d/u);
});

const block = (prefix: string) =>
  Array.from({ length: 1_001 }, (_, index) => `${prefix}-${index}`).join("\n");

test("a proposed edit too complex to compare skips its diff", () => {
  const row = liveRow("edit", {
    path: "/project/a.ts",
    edits: [{ oldText: block("old"), newText: block("new") }],
  });
  for (const expanded of [false, true]) {
    row.setExpanded(expanded);
    const rendered = text(row);
    assert.match(rendered, /a\.ts/u);
    assert.doesNotMatch(rendered, /old-5\b/u);
  }
});
