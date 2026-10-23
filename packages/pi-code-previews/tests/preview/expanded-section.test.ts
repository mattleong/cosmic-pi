import assert from "node:assert/strict";
import { plainTheme } from "pi-cosmic-core/testing";
import { test } from "vitest";
import { expandedSection } from "../../src/preview/expanded-section";

test("an expanded section shows its content's current rows at the current width", () => {
  let lines = ["first"];
  const section = expandedSection(plainTheme, "Output", { render: () => lines, invalidate() {} });
  const body = (width: number) => section.render(width).slice(1);
  assert.deepEqual(body(40), ["    first"]);
  assert.deepEqual(body(40), ["    first"]);
  lines = ["second"];
  assert.deepEqual(body(40), ["    second"]);
  assert.deepEqual(body(4), ["  second"]);
});
