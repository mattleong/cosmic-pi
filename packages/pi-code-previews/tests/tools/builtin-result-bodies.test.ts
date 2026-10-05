import { afterEach, describe, expect, test } from "vitest";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { createToolPresentationHarness, type ToolPresentationHarness } from "../../testing";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { setCodePreviewSettings } from "../../src/config/state";
import { createBuiltinPreviewRenderers } from "../../src/tools/renderers/registration";
import { ALL_CODE_PREVIEW_TOOLS } from "../../src/tools/names";
import { stripAnsi } from "../support/render";

type Style = "compact" | "preview";

function harness(name: string, style: Style) {
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    tools: [...ALL_CODE_PREVIEW_TOOLS],
    toolCallCollapsedStyle: style,
    toolCallTiming: false,
    grepCollapsedLines: 8,
    pathListCollapsedLines: 8,
  });
  const renderers = createBuiltinPreviewRenderers(name, {
    cwd: "/project",
    selfShell: true,
    scheduleAnimation: () => () => undefined,
  });
  return createToolPresentationHarness(renderers!);
}

function render(
  name: string,
  style: Style,
  args: Parameters<ToolPresentationHarness["call"]>[0],
  value: AgentToolResult<unknown>,
  expanded: boolean,
): string {
  const tool = harness(name, style);
  tool.call(args, { expanded });
  tool.result(value, { expanded });
  return stripAnsi(tool.render(200).join("\n"));
}

const count = (text: string, phrase: string) => text.split(phrase).length - 1;
const contentLines = (format: (index: number) => string) =>
  Array.from({ length: 20 }, (_, index) => format(index + 1)).join("\n");

afterEach(() => setCodePreviewSettings(defaultCodePreviewSettings));

// Each output has 20 content lines; the blank separator and notice would make 22.
const notices = [
  {
    name: "grep",
    args: { pattern: "needle", path: "/project" },
    text: contentLines((line) => `src/a.ts:${line}: needle ${line}`),
    notice: "20 matches limit reached. Use limit=40 for more, or refine pattern",
    details: { matchLimitReached: 20 },
  },
  {
    name: "find",
    args: { pattern: "*.ts", path: "/project" },
    text: contentLines((line) => `src/file-${line}.ts`),
    notice: "20 results limit reached. Use limit=40 for more, or refine pattern",
    details: { resultLimitReached: 20 },
  },
  {
    name: "ls",
    args: { path: "/project" },
    text: contentLines((line) => `file-${line}.ts`),
    notice: "20 entries limit reached. Use limit=40 for more",
    details: { entryLimitReached: 20 },
  },
  {
    name: "bash",
    args: { command: "cat build.log" },
    text: contentLines((line) => `log ${line}`),
    notice: "Showing lines 31-50 of 50. Full output: /tmp/pi-bash-output.log",
    details: { truncation: { truncated: true }, fullOutputPath: "/tmp/pi-bash-output.log" },
  },
] as const;

describe("agent notices in builtin output", () => {
  for (const fixture of notices) {
    test(`${fixture.name} keeps Pi's notice out of collapsed output and labels it when expanded`, () => {
      const value = {
        content: [{ type: "text" as const, text: `${fixture.text}\n\n[${fixture.notice}]` }],
        details: fixture.details,
      };
      for (const style of ["preview", "compact"] as const) {
        const collapsed = render(fixture.name, style, fixture.args, value, false);
        expect(collapsed).not.toContain("limit=40");
        expect(collapsed).not.toContain("of 50");
        // The notice and its separator are not output lines.
        expect(collapsed).not.toMatch(/\b22\b/u);
        const expanded = render(fixture.name, style, fixture.args, value, true);
        expect(count(expanded, fixture.notice)).toBe(1);
        expect(expanded).toContain(fixture.name === "bash" ? "log 20" : "20");
      }
    });
  }

  test("bash separates only Pi's own truncation notice, including after a failure", () => {
    // Ordinary bracketed command output remains output.
    const printed = { content: [{ type: "text" as const, text: "start\n\n[done]" }], details: {} };
    expect(render("bash", "preview", { command: "./run" }, printed, false)).toContain("[done]");
    const notice = "Showing lines 31-50 of 50. Full output: /tmp/pi-bash-output.log";
    const value = {
      content: [
        {
          type: "text" as const,
          text: `${contentLines((line) => `log ${line}`)}\n\n[${notice}]\n\nCommand exited with code 1`,
        },
      ],
      details: { truncation: { truncated: true }, fullOutputPath: "/tmp/pi-bash-output.log" },
    };
    const tool = harness("bash", "preview");
    tool.call({ command: "make" });
    tool.result(value, { isError: true });
    expect(stripAnsi(tool.render(200).join("\n"))).not.toContain("of 50");
    tool.call({ command: "make" }, { expanded: true });
    tool.result(value, { isError: true, expanded: true });
    expect(stripAnsi(tool.render(200).join("\n"))).toContain(notice);
  });
});

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

  test("the heading names the lines Pi reads for offset 0", () => {
    const tool = harness("read", "preview");
    tool.call({ path: "/project/a.ts", offset: 0, limit: 3 });
    const heading = stripAnsi(tool.render(200).join("\n"));
    expect(heading).toContain("a.ts:1-3");
    expect(heading).not.toContain(":0-2");
  });

  test("plain text drops CRLF carriage returns as highlighting does, keeping lone ones", () => {
    // Without a highlighter, file content renders as plain text.
    const value = {
      content: [{ type: "text" as const, text: "first\r\nsecond\r\nlone\rreturn" }],
      details: {},
    };
    for (const style of ["preview", "compact"] as const) {
      const expanded = render("read", style, { path: "/project/notes.txt" }, value, true);
      expect(count(expanded, "␍")).toBe(1);
      expect(expanded).toContain("lone␍return");
    }
  });
});
