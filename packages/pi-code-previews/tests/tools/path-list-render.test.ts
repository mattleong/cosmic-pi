import assert from "node:assert/strict";
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { renderComponent, testTheme } from "../../src/testing/render";
import {
  renderPathListResult,
  type PathListResultConfig,
} from "../../src/tools/renderers/shared/path-list-result";

const config: PathListResultConfig = {
  cwd: "/project",
  iconMode: "off",
  previewEnabled: true,
  loadingLabel: "Loading",
  errorLabel: "Failed",
  emptyMarker: "No paths",
  emptyLabel: () => "No paths",
  collapsedLines: 8,
  footerNoun: "paths",
};

function result(text: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details: undefined };
}

function renderCollapsed(text: string, theme: Theme = testTheme()): string {
  return renderComponent(
    renderPathListResult(
      result(text),
      { expanded: false, isPartial: false },
      theme,
      { isError: false, state: {} },
      config,
    ),
    160,
  )
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

test("collapsed tree chunks do not repeat directory headings after the hidden-lines marker", () => {
  const rendered = renderCollapsed(
    Array.from({ length: 12 }, (_, index) => `src/file-${index}.ts`).join("\n"),
  );
  const lines = rendered.split("\n");

  assert.equal(lines.filter((line) => line === "src/").length, 1);
  assert.equal(lines.filter((line) => line === "  file-11.ts").length, 1);
  assert.equal(rendered.match(/--- 5 lines hidden ---/g)?.length, 1);
  assert.match(rendered, /Showing 7 of 12 paths/);
});

test("collapsed head and tail chunks use one tree-mode decision", () => {
  const lines = Array.from({ length: 12 }, (_, index) => `file-${index}.ts`);
  lines[11] = "src/tail.ts";
  // SAFETY: This test double changes only Theme.fg, the sole method this renderer exercises.
  const theme = {
    ...testTheme(),
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  } as Theme;

  const rendered = renderCollapsed(lines.join("\n"), theme);

  assert.match(rendered, /<toolOutput>file-0\.ts<\/toolOutput>/);
  assert.doesNotMatch(rendered, /<accent>file-0\.ts<\/accent>/);
  assert.match(rendered, /<accent>src\/<\/accent>/);
  assert.match(rendered, /--- 5 lines hidden ---/);
});

test("collapsed flat lists retain linear paths and hidden-lines markers", () => {
  const rendered = renderCollapsed(
    Array.from({ length: 12 }, (_, index) => `file-${index}.ts`).join("\n"),
  );
  const lines = rendered.split("\n");

  assert.deepEqual(lines.slice(0, 6), [
    "file-0.ts",
    "file-1.ts",
    "file-2.ts",
    "file-3.ts",
    "file-4.ts",
    "file-5.ts",
  ]);
  assert.equal(lines[6], "      --- 5 lines hidden ---");
  assert.equal(lines[7], "file-11.ts");
  assert.match(rendered, /Showing 7 of 12 paths/);
});
