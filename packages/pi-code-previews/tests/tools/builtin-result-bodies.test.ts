import { beforeEach, describe, expect, test } from "vitest";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { applyPresentationSettings, createToolPresentationHarness } from "../../testing";
import type { BuiltinCompactTool } from "../../src/tools/builtin-subject";
import { builtinRenderers, stripAnsi } from "../support/render";
import * as Arr from "effect/Array";

type Style = "compact" | "preview";

beforeEach(() =>
  applyPresentationSettings({
    toolCallTiming: false,
    grepCollapsedLines: 8,
    pathListCollapsedLines: 8,
  }),
);

const text = (value: string): AgentToolResult<unknown> => ({
  content: [{ type: "text", text: value }],
  details: {},
});

function harness(name: BuiltinCompactTool, style: Style) {
  applyPresentationSettings({ toolCallCollapsedStyle: style });
  const renderers = builtinRenderers(name, true);
  return createToolPresentationHarness(renderers!);
}

function render(
  name: BuiltinCompactTool,
  style: Style,
  args: Parameters<ReturnType<typeof harness>["call"]>[0],
  value: AgentToolResult<unknown>,
  expanded: boolean,
): string {
  const tool = harness(name, style);
  tool.call(args, { expanded });
  tool.result(value, { expanded });
  return stripAnsi(Arr.join(tool.render(200), "\n"));
}

describe("read results", () => {
  test("an oversized first line is reported, never drawn as file content", () => {
    const instruction =
      "Line 40 is 61.2KB, exceeds 50.0KB limit. Use bash: sed -n '40p' /project/big.js | head -c 51200";
    const value = {
      content: [{ type: "text" as const, text: `[${instruction}]` }],
      details: { truncation: { truncated: true, firstLineExceedsLimit: true } },
    };
    const args = { path: "/project/big.js", offset: 40 };
    for (const style of ["preview", "compact"] as const) {
      const collapsed = render("read", style, args, value, false);
      expect(collapsed).not.toContain("sed -n");
      expect(collapsed).not.toMatch(/^\s*40\s*│/mu);
      const expanded = render("read", style, args, value, true);
      expect(expanded).toContain(instruction);
      expect(expanded).not.toMatch(/^\s*40\s*│/mu);
    }
  });

  test("numeric-string ranges render like the numbers Pi coerces them to", () => {
    applyPresentationSettings({ readLineNumbers: true });
    const value = text(
      "line 120\nline 121\nline 122\n\n[37 more lines in file. Use offset=123 to continue.]",
    );
    const path = "/project/a.ts";
    const cases = [
      [
        { offset: "120", limit: "3" },
        { offset: 120, limit: 3 },
      ],
      [{ offset: " 120 " }, { offset: 120 }],
      [{ limit: "3" }, { limit: 3 }],
      [
        { offset: "0", limit: "3" },
        { offset: 0, limit: 3 },
      ],
    ] as const;
    for (const style of ["preview", "compact"] as const)
      for (const expanded of [false, true]) {
        const unranged = render("read", style, { path }, value, expanded);
        for (const [raw, coerced] of cases) {
          const rendered = render("read", style, { path, ...raw }, value, expanded);
          expect(rendered).toBe(render("read", style, { path, ...coerced }, value, expanded));
          expect(rendered).not.toBe(unranged);
        }
      }
  });
});

describe("grep calls", () => {
  test("a numeric-string limit is shown like the number Pi coerces it to", () => {
    const value = text("a.ts:3: // TODO fix the retry");
    const args = { pattern: "TODO", path: "/project/src" };
    for (const style of ["preview", "compact"] as const)
      for (const expanded of [false, true])
        expect(render("grep", style, { ...args, limit: "50" }, value, expanded)).toBe(
          render("grep", style, { ...args, limit: 50 }, value, expanded),
        );
    expect(render("grep", "preview", { ...args, limit: "50" }, value, false)).not.toBe(
      render("grep", "preview", args, value, false),
    );
  });
});
