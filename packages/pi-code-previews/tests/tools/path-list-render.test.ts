import assert from "node:assert/strict";
import { test } from "vitest";
import { renderContextFixture, withPresentationSettings } from "../../testing";
import { plainTheme, renderComponent, textResult } from "../support/render";
import { pathListPreviewRenderers } from "../../src/tools/renderers/path-list";
import * as Arr from "effect/Array";
import * as Str from "effect/String";

function renderCollapsed(paths: string[]): string[] {
  const rendered = withPresentationSettings({ pathIcons: "off", pathListCollapsedLines: 8 }, () =>
    renderComponent(
      pathListPreviewRenderers("find", "/project").renderResult(
        textResult(Arr.join(paths, "\n")),
        { expanded: false, isPartial: false },
        plainTheme,
        renderContextFixture({ isPartial: false }),
      ),
      160,
    ),
  );
  return Arr.map(Str.split(rendered, "\n"), (line) => Str.trimEnd(line));
}

test("tree output draws each path under its own folder whatever the input order", () => {
  const lines = renderCollapsed([
    "src/a.ts",
    "tests/b.ts",
    "src/c.ts",
    "src/lib/d.ts",
    "tests/e.ts",
  ]);
  const position = (line: string) => lines.indexOf(line);

  assert.equal(Arr.filter(lines, (line) => line === "src/").length, 1);
  assert.equal(Arr.filter(lines, (line) => line === "tests/").length, 1);
  for (const file of ["  a.ts", "  c.ts", "    d.ts"]) {
    assert.ok(position(file) > position("src/"), file);
    assert.ok(position(file) < position("tests/"), file);
  }
  assert.ok(position("  b.ts") > position("tests/"));
  assert.ok(position("  e.ts") > position("tests/"));
});

test("absolute listing paths stay distinct from relative paths and retain the root entry", () => {
  const lines = renderCollapsed(["/", "/etc/hosts", "etc/passwd"]);

  assert.ok(lines.includes("/"));
  assert.ok(lines.includes("/etc/hosts"));
  assert.ok(lines.includes("etc/passwd"));
});
