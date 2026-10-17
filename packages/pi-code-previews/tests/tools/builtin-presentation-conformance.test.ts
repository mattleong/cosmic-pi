import { beforeEach, describe, expect, test } from "vitest";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { applyPresentationSettings, createToolPresentationHarness } from "../../testing";
import type { BuiltinCompactTool } from "../../src/tools/builtin-subject";
import { builtinRenderers, previewBodiesDisabled, stripAnsi } from "../support/render";
import * as Match from "effect/Match";

const cases = [
  {
    name: "bash",
    args: { command: "printf 'FIRST_COMMAND\\n'\nprintf 'LAST_COMMAND\\n'" },
    output: "first log\nlast log",
    retained: "last log",
  },
  {
    name: "read",
    args: { path: "/project/source.ts" },
    output: "const first = 1;\nconst last = 2;",
    retained: "const last",
  },
  {
    name: "write",
    args: { path: "/project/source.ts", content: "const first = 1;\nconst last = 2;" },
    output: "Successfully wrote 38 bytes to /project/source.ts",
    retained: "const last",
  },
  {
    name: "edit",
    args: {
      path: "/project/source.ts",
      edits: Array.from({ length: 5 }, (_, index) => ({
        oldText: `OLD_${index}`,
        newText: `NEW_${index}`,
      })),
    },
    output: "Successfully replaced text in /project/source.ts.",
    retained: "NEW_4",
  },
  {
    name: "grep",
    args: { pattern: "needle", path: "/project", context: 2 },
    output: "source.ts:1:needle\nsource.ts:2:tail",
    retained: "tail",
  },
  {
    name: "find",
    args: { pattern: "*.ts", path: "/project" },
    output: "src/first.ts\nsrc/last.ts",
    retained: "last.ts",
  },
  { name: "ls", args: { path: "/project" }, output: "first.ts\nlast.ts", retained: "last.ts" },
] as const;

function builtin(
  name: BuiltinCompactTool,
  mode: "off" | "on" | "border" = "off",
  style: "compact" | "preview" = "compact",
  options?: Parameters<typeof createToolPresentationHarness>[1],
) {
  applyPresentationSettings({ toolCallBackground: mode, toolCallCollapsedStyle: style });
  const renderers = builtinRenderers(name, true);
  return createToolPresentationHarness(renderers!, options);
}
function result(...texts: string[]): AgentToolResult<unknown> {
  return { content: texts.map((text) => ({ type: "text" as const, text })), details: {} };
}
function plain(lines: string[]) {
  return stripAnsi(lines.join("\n"));
}
beforeEach(() => applyPresentationSettings({ toolCallTiming: false, ...previewBodiesDisabled }));

const sourceMarkers = (name: string): string[] =>
  Match.value(name).pipe(
    Match.when("bash", () => ["FIRST_COMMAND", "LAST_COMMAND"]),
    Match.when("write", () => ["const first", "const last"]),
    Match.when("edit", () => ["OLD_4", "NEW_4"]),
    Match.orElse(() => []),
  );

describe("registered builtin presentation", () => {
  for (const fixture of cases) {
    test(`${fixture.name} retains expanded content across toggles and narrow widths`, () => {
      for (const mode of ["off", "on", "border"] as const) {
        const harness = builtin(fixture.name, mode);
        harness.call(fixture.args);
        harness.result(result(fixture.output), { isPartial: true });
        expect(plain(harness.render(100)).includes(fixture.retained)).toBe(false);
        harness.result(result(fixture.output));
        for (const expanded of [true, false, true]) {
          harness.call(fixture.args, { expanded });
          harness.result(result(fixture.output), { expanded });
          const text = plain(harness.render(100));
          expect(text.includes(fixture.retained)).toBe(expanded);
          for (const marker of sourceMarkers(fixture.name))
            expect(!expanded || text.includes(marker)).toBe(true);
          for (const width of [16, 40])
            expect(harness.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
          harness.invalidate();
        }
      }
    });
    test(`${fixture.name} tolerates malformed arguments and cancellation`, () => {
      const harness = builtin(fixture.name);
      harness.call({ path: 17, command: false, edits: [null] }, { expanded: true });
      harness.result(result("Operation aborted"), { expanded: true, isError: true });
      expect(() => harness.render(20)).not.toThrow();
    });
  }
  test("read leaves image bytes native and retains companion text in both styles", () => {
    for (const style of ["compact", "preview"] as const) {
      const harness = builtin("read", "off", style);
      const image = { type: "image" as const, data: "NATIVE_IMAGE_BYTES", mimeType: "image/png" };
      const value = {
        content: [{ type: "text" as const, text: "image companion" }, image],
        details: {},
      };
      harness.call({ path: "photo.png" }, { expanded: true });
      harness.result(value, { expanded: true });
      const text = plain(harness.render());
      expect(text).toContain("image companion");
      expect(text).not.toContain(image.data);
      expect(value.content[1]).toBe(image);
    }
  });
});
