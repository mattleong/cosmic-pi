// Preview-style write and edit rows rendered through Pi's own component, which renders the call
// before the result on every update.
import assert from "node:assert/strict";
import {
  generateDiffString,
  initTheme,
  type AgentToolResult,
  type ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, test } from "vitest";
import { hostToolRow } from "../../../testing";
import { defaultCodePreviewSettings } from "../../../src/config/defaults";
import type { CodePreviewSettings } from "../../../src/config/schema";
import { setCodePreviewSettings } from "../../../src/config/state";
import { ALL_CODE_PREVIEW_TOOLS } from "../../../src/tools/names";
import { builtinRenderers, stripAnsi } from "../../support/render";

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
const rows = (row: ToolExecutionComponent) => row.render(120).length;
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
  // Unchanged leading lines appear only in the proposed content, not in the diff's context.
  assert.match(text(row), /line 0\b/u);
  row.markExecutionStarted();
  assert.match(text(row), /line 0\b/u);
  row.updateResult(overwrite);
  const settled = text(row);
  assert.equal(count(settled, /LINE 10/gu), 1);
  assert.doesNotMatch(settled, /line 0\b/u);
  // Expansion keeps the exact written content above the diff.
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

test("a successful write without a diff adds no outcome rows", () => {
  for (const details of [{}, { codePreviewBeforeWrite: undefined }]) {
    const row = liveRow("write", { path: "/project/a.txt", content });
    row.markExecutionStarted();
    const running = rows(row);
    row.updateResult(result("Successfully wrote to a.txt", details));
    assert.equal(rows(row), running);
  }
  const fresh = liveRow("write", { path: "/project/a.txt", content });
  fresh.updateResult(result("Successfully wrote to a.txt", { codePreviewBeforeWrite: undefined }));
  assert.equal(count(text(fresh), /new file/giu), 1);
});

test("the write heading counts lines the same way with the preview on or off", () => {
  const heading = (writeContentPreview: boolean) =>
    text(liveRow("write", { path: "/project/a.txt", content: "a\n\n\n" }, { writeContentPreview }))
      .split("\n")
      .find((line) => line.includes("a.txt"))
      ?.trim();
  assert.equal(heading(true), heading(false));
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
  // Expansion keeps the exact proposed edit above the applied diff.
  row.setExpanded(true);
  assert.equal(count(text(row), /BETA/gu), 2);

  const failed = liveRow("edit", edit);
  failed.markExecutionStarted();
  failed.updateResult(result("Could not find the exact text in /project/a.ts.", undefined, true));
  assert.match(text(failed), /BETA/u);
});

test("a proposed edit does not number its rows as file lines", () => {
  // The snippet's own line 2 is not line 2 of the file.
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
