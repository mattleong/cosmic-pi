import assert from "node:assert/strict";
import { test } from "vitest";
import { plainTheme, renderComponent, textResult } from "../support/render";
import {
  renderPathListResult,
  type PathListResultConfig,
} from "../../src/tools/renderers/shared/path-list-result";

const config: PathListResultConfig = {
  cwd: "/project",
  iconMode: "off",
  previewEnabled: true,
  loadingLabel: "Loading",
  emptyMarker: "No paths",
  emptyLabel: () => "No paths",
  collapsedLines: 8,
  footerNoun: "paths",
};

function renderCollapsed(text: string): string {
  return renderComponent(
    renderPathListResult(
      textResult(text),
      { expanded: false, isPartial: false },
      plainTheme,
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

test("tree output draws each path under its own folder whatever the input order", () => {
  const lines = renderCollapsed(
    ["src/a.ts", "tests/b.ts", "src/c.ts", "src/lib/d.ts", "tests/e.ts"].join("\n"),
  ).split("\n");
  const position = (line: string) => lines.indexOf(line);

  assert.equal(lines.filter((line) => line === "src/").length, 1);
  assert.equal(lines.filter((line) => line === "tests/").length, 1);
  for (const file of ["  a.ts", "  c.ts", "    d.ts"]) {
    assert.ok(position(file) > position("src/"), file);
    assert.ok(position(file) < position("tests/"), file);
  }
  assert.ok(position("  b.ts") > position("tests/"));
  assert.ok(position("  e.ts") > position("tests/"));
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
  assert.match(lines[6] ?? "", /5 lines hidden/);
  assert.equal(lines[7], "file-11.ts");
  assert.match(rendered, /Showing 7 of 12 paths/);
});
