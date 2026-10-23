import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { applyPresentationSettings, createToolPresentationHarness } from "../../testing";
import { codemodeRenderers, nativeCall, scriptResult } from "../support/native-codemode";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

const settings = (
  style: "compact" | "preview",
  timing = false,
  background: "off" | "on" | "border" = "off",
) =>
  applyPresentationSettings({
    toolCallCollapsedStyle: style,
    toolCallTiming: timing,
    toolCallBackground: background,
  });
const completed = scriptResult(
  "completed",
  { calls: [] },
  { type: "text", text: "OUTPUT_RETAINED" },
);
beforeEach(() => applyPresentationSettings({ syntaxHighlighting: false }));
afterEach(() => vi.restoreAllMocks());

for (const style of ["compact", "preview"] as const)
  test(`native ${style} expansion preserves bounded calls with oversized or unknown history`, () => {
    settings(style);
    const records = Array.from({ length: 257 }, (_, index) =>
      nativeCall({ id: `private/${index}`, args: `{"path":"/project/record-${index}.ts"}` }),
    );
    const retained = [
      ...records.slice(0, -1),
      { ...records[256]!, status: "error", error: "LAST_FAILURE" },
    ];
    const result = {
      ...completed,
      details: { calls: retained, fullOutputPath: "/tmp/RECOVERY_PATH" },
    };
    const before = structuredClone(result);
    for (const unknownHeader of [false, true]) {
      const h = createToolPresentationHarness(codemodeRenderers());
      const rendered = unknownHeader
        ? {
            ...result,
            content: [{ type: "text" as const, text: "UNKNOWN_HEADER\nOUTPUT_RETAINED" }],
          }
        : result;
      h.call({ code: "// SOURCE_RETAINED" }, { expanded: true });
      h.result(rendered, { expanded: true });
      const text = Arr.join(h.render(120), "\n");
      for (const marker of [
        "SOURCE_RETAINED",
        "record-256.ts",
        "LAST_FAILURE",
        "OUTPUT_RETAINED",
        "RECOVERY_PATH",
      ])
        assert.ok(Fn.pipe(text, Str.includes(marker)), marker);
    }
    assert.deepEqual(result, before);
  });
