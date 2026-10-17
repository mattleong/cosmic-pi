import { beforeEach, describe, expect, test } from "vitest";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { applyPresentationSettings, createToolPresentationHarness } from "../../testing";
import type { BuiltinCompactTool } from "../../src/tools/builtin-subject";
import { builtinRenderers, stripAnsi } from "../support/render";

type Style = "compact" | "preview";

beforeEach(() =>
  applyPresentationSettings({
    toolCallTiming: false,
    grepCollapsedLines: 8,
    pathListCollapsedLines: 8,
  }),
);

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
  return stripAnsi(tool.render(200).join("\n"));
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
});
