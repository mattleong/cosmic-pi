import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, test } from "vitest";
import {
  applyPresentationSettings,
  createToolPresentationHarness,
  renderContextFixture,
} from "../../testing";
import { codemodeRenderers } from "../support/native-codemode";
import { nativeCodemodeSummary } from "../../src/tools/native-codemode-summary";
import { compactStatus } from "../../src/tools/compact-summary";
import { stripAnsi } from "../support/render";

beforeEach(() =>
  applyPresentationSettings({
    syntaxHighlighting: false,
    toolCallTiming: false,
    toolCallBackground: "off",
  }),
);

for (const style of ["compact", "preview"] as const)
  test(`native ${style} exposes omitted failures while preserving active selection and expansion`, () => {
    applyPresentationSettings({ toolCallCollapsedStyle: style });
    const h = createToolPresentationHarness(codemodeRenderers());
    const args = { code: "// PROGRAM_RETAINED" };
    const result = {
      content: [{ type: "text" as const, text: "OUTPUT_RETAINED" }],
      details: {
        calls: [
          {
            id: "private/failed",
            name: "mcp__docs__lookup",
            args: '{"query":"ARGUMENT_RETAINED"}',
            status: "error",
            error: "FAILURE_RETAINED\nDIAGNOSTIC_RETAINED",
          },
          ...Array.from({ length: 5 }, (_, index) => ({
            id: `private/active-${index}`,
            name: "read",
            args: JSON.stringify({ path: `/project/active-${index}.ts` }),
            status: "running",
          })),
        ],
      },
    };
    const before = structuredClone(result);
    const summary = nativeCodemodeSummary("/project")({
      phase: "running",
      args,
      result,
      context: renderContextFixture({ executionStarted: true, isPartial: true }),
    });
    assert.ok(summary);
    assert.equal(compactStatus("running", summary), "running");
    h.call(args, { executionStarted: true, isPartial: true });
    h.result(result, { isPartial: true });
    for (const width of [16, 24, 40, 80]) {
      const rows = h.render(width);
      assert.ok(rows.every((row) => visibleWidth(row) <= width));
      assert.ok(stripAnsi(rows.join("")).replace(/\s/gu, "").includes("1failed"));
    }
    h.call(args, { expanded: true, isPartial: true });
    h.result(result, { expanded: true, isPartial: true });
    const expanded = stripAnsi(h.render(160).join("\n"));
    for (const marker of [
      "PROGRAM_RETAINED",
      "mcp__docs__lookup",
      "ARGUMENT_RETAINED",
      "FAILURE_RETAINED",
      "DIAGNOSTIC_RETAINED",
      "OUTPUT_RETAINED",
      ...Array.from({ length: 5 }, (_, index) => `active-${index}.ts`),
    ])
      assert.ok(expanded.includes(marker), marker);
    assert.deepEqual(result, before);
  });
