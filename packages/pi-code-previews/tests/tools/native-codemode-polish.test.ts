import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";
import { applyPresentationSettings, createToolPresentationHarness } from "../../testing";
import { codemodeRenderers, nativeCall, scriptResult } from "../support/native-codemode";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";

const completed = scriptResult(
  "completed",
  { calls: [] },
  { type: "text", text: "OUTPUT_RETAINED" },
);
beforeEach(() => applyPresentationSettings({ syntaxHighlighting: false }));

for (const style of ["compact", "preview"] as const)
  test(`native ${style} expansion preserves bounded calls with oversized or unknown history`, () => {
    applyPresentationSettings({
      toolCallCollapsedStyle: style,
      toolCallTiming: false,
      toolCallBackground: "off",
    });
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

test("a program ending in a line break leaves no blank row before the next section", () => {
  applyPresentationSettings({
    toolCallCollapsedStyle: "compact",
    toolCallTiming: false,
    toolCallBackground: "off",
  });
  const h = createToolPresentationHarness(codemodeRenderers());
  h.call({ code: "const total = 1 + 2;\ntext(String(total));\n" }, { expanded: true });
  h.result(completed, { expanded: true });
  const rows = h.render(80);
  const last = Option.getOrThrow(
    Arr.findFirstIndex(rows, (row) => Fn.pipe(row, Str.includes("text(String(total));"))),
  );
  assert.ok(Str.isNonEmpty(Str.trim(rows[last + 1] ?? "")));
});
