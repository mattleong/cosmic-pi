import assert from "node:assert/strict";
import { test } from "vitest";
import { renderPathListLines } from "../../src/tools/path-list-render";
import { stripAnsi, testTheme } from "../../src/testing/render";

test("renderPathListLines groups nested paths", () => {
  const lines = renderPathListLines(
    "src/tools/renderers/registration.ts\nsrc/diff/index.ts\nsrc/testing/render.ts",
    "/tmp/project",
    testTheme(),
    { iconMode: "unicode" },
  );
  const plain = stripAnsi(lines.join("\n"));
  assert.match(plain, /▸ src\//);
  assert.match(plain, /▸ tools\//);
  assert.match(plain, /▸ renderers\//);
  assert.match(plain, /• registration\.ts/);
  assert.match(plain, /▸ testing\//);
});

test("path list rendering can disable icons or use Nerd Font icons", () => {
  assert.doesNotMatch(
    stripAnsi(
      renderPathListLines("src/tools/renderers/registration.ts", "/tmp/project", testTheme(), {
        iconMode: "off",
      }).join("\n"),
    ),
    /[▸•]/,
  );

  const nerd = stripAnsi(
    renderPathListLines("src/tools/renderers/registration.ts", "/tmp/project", testTheme(), {
      iconMode: "nerd",
    }).join("\n"),
  );
  assert.match(nerd, /\ue5ff src\//);
  assert.match(nerd, /\ue628 registration\.ts/);
});
