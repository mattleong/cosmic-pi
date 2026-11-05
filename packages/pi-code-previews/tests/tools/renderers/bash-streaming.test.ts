import { beforeEach, expect, test } from "vitest";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { applyPresentationSettings, renderContextFixture } from "../../../testing";
import { bashPreviewRenderers } from "../../../src/tools/renderers/bash";
import { plainTheme, renderComponent, stripAnsi, textResult } from "../../support/render";

beforeEach(() =>
  applyPresentationSettings({ toolCallCollapsedStyle: "preview", bashResultPreview: true }),
);

const lines = (count: number) =>
  Arr.map(Arr.range(1, count), (index) => `✓ tests/suite-${index}.test.ts`);

const streamed = (output: string) =>
  Arr.map(
    Str.split(
      stripAnsi(
        renderComponent(
          bashPreviewRenderers().renderResult(
            textResult(output),
            { expanded: false, isPartial: true },
            plainTheme,
            renderContextFixture({ args: { command: "pnpm test" }, state: {}, isPartial: true }),
          ),
        ),
      ),
      "\n",
    ),
    Str.trim,
  );

test("a running bash call shows its latest output and names the earlier lines it hides", () => {
  const rows = streamed(Arr.join(lines(12), "\n"));
  expect(rows).toContain("✓ tests/suite-12.test.ts");
  expect(rows).not.toContain("✓ tests/suite-1.test.ts");
  const affordance = Arr.filter(rows, (row) => Str.startsWith("▸ ")(row));
  expect(affordance).toHaveLength(1);
  expect(affordance[0]).toMatch(/\b7\b/u);
});

test("a running bash call whose output fits shows all of it without an affordance", () => {
  const rows = streamed(Arr.join(lines(3), "\n"));
  expect(rows).toContain("✓ tests/suite-1.test.ts");
  expect(Arr.filter(rows, (row) => Str.startsWith("▸ ")(row))).toHaveLength(0);
});
