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

const rendered = (output: string, isPartial: boolean) =>
  Arr.map(
    Str.split(
      stripAnsi(
        renderComponent(
          bashPreviewRenderers().renderResult(
            textResult(output),
            { expanded: false, isPartial },
            plainTheme,
            renderContextFixture({ args: { command: "pnpm test" }, state: {}, isPartial }),
          ),
        ),
      ),
      "\n",
    ),
    Str.trim,
  );

const streamed = (output: string) => rendered(output, true);

test("a running bash call shows its latest output and names the earlier lines it hides", () => {
  const rows = streamed(Arr.join(lines(12), "\n"));
  expect(rows).toContain("✓ tests/suite-12.test.ts");
  expect(rows).not.toContain("✓ tests/suite-1.test.ts");
  const affordance = Arr.filter(rows, (row) => Str.startsWith("▸ ")(row));
  expect(affordance).toHaveLength(1);
  expect(affordance[0]).toMatch(/\b7\b/u);
  // The earlier lines are named where they would be: before the tail, not after it.
  expect(rows.indexOf(affordance[0] ?? "")).toBeLessThan(rows.indexOf("✓ tests/suite-8.test.ts"));
});

test("settled bash output longer than its preview names the hidden lines once, where they are hidden", () => {
  const rows = rendered(Arr.join(lines(14), "\n"), false);
  const standIns = Arr.filter(
    rows,
    (row) => Str.startsWith("▸ ")(row) || Str.includes("hidden")(row),
  );
  expect(standIns).toHaveLength(1);
  expect(standIns[0]).toMatch(/\b7\b/u);
  const at = rows.indexOf(standIns[0] ?? "");
  expect(at).toBeGreaterThan(rows.indexOf("✓ tests/suite-1.test.ts"));
  expect(at).toBeLessThan(rows.indexOf("✓ tests/suite-14.test.ts"));
});

test("a running bash call whose output fits shows all of it without an affordance", () => {
  const rows = streamed(Arr.join(lines(3), "\n"));
  expect(rows).toContain("✓ tests/suite-1.test.ts");
  expect(Arr.filter(rows, (row) => Str.startsWith("▸ ")(row))).toHaveLength(0);
});
