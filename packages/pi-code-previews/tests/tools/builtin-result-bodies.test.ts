import { beforeEach, describe, expect, test } from "vitest";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { applyPresentationSettings, createToolPresentationHarness } from "../../testing";
import type { BuiltinCompactTool } from "../../src/tools/builtin-subject";
import { builtinRenderers, stripAnsi, textResult } from "../support/render";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

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
    const value = textResult(
      "line 120\nline 121\nline 122\n\n[37 more lines in file. Use offset=123 to continue.]",
      {},
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

  test("a wrapped line continues under the gutter instead of in the line-number column", () => {
    applyPresentationSettings({ readLineNumbers: true });
    const line = "export function subtotal(items: LineItem[]): number {";
    for (const style of ["preview", "compact"] as const) {
      const tool = harness("read", style);
      tool.call({ path: "/project/cart.ts" }, { expanded: true });
      tool.result(textResult(`${line}\n}`, {}), { expanded: true });
      const text = Arr.join(Arr.map(tool.render(40), stripAnsi), "\n");
      const wrapped = /^( *)1 │ export[^\n]*\n( *)│ ([^\n]*)$/mu.exec(text);
      // The continuation's `│` sits under the line's own gutter, with no number before it.
      expect(wrapped?.[2]?.length).toBe((wrapped?.[1]?.length ?? -1) + 2);
      // The wrap lands between words rather than splitting one.
      expect(Fn.pipe(line, Str.endsWith(` ${Str.trim(wrapped?.[3] ?? "")}`))).toBe(true);
    }
  });
});

describe("write content", () => {
  test("a wrapped line continues past its own indentation", () => {
    applyPresentationSettings({ toolCallCollapsedStyle: "compact" });
    const tool = createToolPresentationHarness(builtinRenderers("write", true)!);
    const content =
      "test('sums', () => {\n    assert.equal(subtotal([{ sku: 'a', price: 5, quantity: 2 }]), 10);\n});";
    tool.call({ path: "/project/cart.test.ts", content }, { expanded: true });
    const text = Arr.join(Arr.map(tool.render(40), stripAnsi), "\n");
    const wrapped = /^( *)assert\.equal[^\n]*\n( *)\S/mu.exec(text);
    expect(wrapped?.[2]?.length).toBe((wrapped?.[1]?.length ?? -1) + 2);
  });
});

describe("grep calls", () => {
  test("a numeric-string limit is shown like the number Pi coerces it to", () => {
    const value = textResult("a.ts:3: // TODO fix the retry", {});
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
