import { expect, test } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderCompactIssues } from "../../src/preview/compact-issues";
import type { CompactIssue } from "../../src/tools/compact-issues";
import { plainTheme as theme, stripAnsi } from "../support/render";

const render = (value: readonly CompactIssue[], width = 100, expanded = false) =>
  renderCompactIssues(value, theme, width, expanded).map(stripAnsi);
const squash = (rows: readonly string[]) => rows.join("").replace(/\s/gu, "");

test("narrow widths wrap messages and details without clipping any text", () => {
  const long: CompactIssue[] = [
    {
      severity: "error",
      code: "wide",
      message: "日本語 failure with a long human explanation 👩‍💻",
      detail: "First detail line with /tmp/retained-output-1234567890.txt\n文字 second line",
    },
    { severity: "info", code: "hint", message: "Continue from line 2001 of 9000" },
  ];
  for (const width of [2, 3, 4, 6, 12, 20, 40])
    for (const expanded of [false, true]) {
      const rows = render(long, width, expanded);
      expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
      const text = squash(rows);
      for (const expected of expanded
        ? [long[0]!.message, ...long[0]!.detail!.split("\n"), long[1]!.message]
        : [long[0]!.message])
        expect(text).toContain(expected.replace(/\s/gu, ""));
      expect(text.includes("Continue")).toBe(expanded);
    }
  expect(render(long, 1, true).every((row) => visibleWidth(row) <= 1)).toBe(true);
});

test("untrusted issue text renders as inert single-line messages", () => {
  const rows = renderCompactIssues(
    [
      {
        severity: "warning",
        code: "hostile",
        message: "first\nsecond\t\u001b[2Jthird\r",
        detail: "detail\u001b[2J\r\nnext",
      },
    ],
    theme,
    80,
    true,
  );
  expect(rows.join("")).not.toContain("\u001b[2J");
  expect(stripAnsi(rows[0]!)).toMatch(/first second.*third/u);
});
