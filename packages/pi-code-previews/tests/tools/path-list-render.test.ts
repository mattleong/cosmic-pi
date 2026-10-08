import assert from "node:assert/strict";
import { test } from "vitest";
import { renderContextFixture, withPresentationSettings } from "../../testing";
import { plainTheme, renderComponent, textResult } from "../support/render";
import { pathListPreviewRenderers } from "../../src/tools/renderers/path-list";

function renderCollapsed(paths: string[]): string[] {
  const rendered = withPresentationSettings({ pathIcons: "off", pathListCollapsedLines: 8 }, () =>
    renderComponent(
      pathListPreviewRenderers("find", "/project").renderResult(
        textResult(paths.join("\n")),
        { expanded: false, isPartial: false },
        plainTheme,
        renderContextFixture({ isPartial: false }),
      ),
      160,
    ),
  );
  return rendered.split("\n").map((line) => line.trimEnd());
}

const files = (prefix: string) =>
  Array.from({ length: 12 }, (_, index) => `${prefix}file-${index}.ts`);

test("collapsed tree chunks do not repeat directory headings after the hidden-lines marker", () => {
  const lines = renderCollapsed(files("src/"));

  assert.equal(lines.filter((line) => line === "src/").length, 1);
  assert.equal(lines.filter((line) => line === "  file-11.ts").length, 1);
  assert.equal(lines.join("\n").match(/--- 5 lines hidden ---/g)?.length, 1);
  assert.match(lines.join("\n"), /Showing 7 of 12 paths/);
});

test("tree output draws each path under its own folder whatever the input order", () => {
  const lines = renderCollapsed([
    "src/a.ts",
    "tests/b.ts",
    "src/c.ts",
    "src/lib/d.ts",
    "tests/e.ts",
  ]);
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
  const lines = renderCollapsed(files(""));

  assert.deepEqual(lines.slice(0, 6), files("").slice(0, 6));
  assert.match(lines[6] ?? "", /5 lines hidden/);
  assert.equal(lines[7], "file-11.ts");
  assert.match(lines.join("\n"), /Showing 7 of 12 paths/);
});
