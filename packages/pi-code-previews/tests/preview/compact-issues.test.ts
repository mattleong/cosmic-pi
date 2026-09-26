import { expect, test } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderCompactIssues } from "../../src/preview/compact-issues";
import type { CompactIssue } from "../../src/tools/compact-issues";
import { plainTheme as theme, stripAnsi } from "../support/render";

const issues: CompactIssue[] = [
  { severity: "warning", code: "secret", message: "Possible private key" },
  {
    severity: "error",
    code: "edit-no-match",
    message: "The text to replace was not found",
    detail: "oldText was not found.\nMatch the original text, including whitespace.",
  },
  {
    severity: "info",
    code: "read-continuation",
    message: "Showing lines 1-2000 of 9000",
    detail: "Use offset=2001 to continue.",
  },
];
const render = (value: readonly CompactIssue[], width = 100, expanded = false) =>
  renderCompactIssues(value, theme, width, expanded).map(stripAnsi);
const squash = (rows: readonly string[]) => rows.join("").replace(/\s/gu, "");

test("collapsed rows show one message per attention issue in producer order", () => {
  const rows = render(issues);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain("Possible private key");
  expect(rows[1]).toContain("The text to replace was not found");
  const text = rows.join("\n");
  expect(text).not.toContain("Showing lines");
  expect(text).not.toContain("oldText");
  expect(text).not.toContain("offset=2001");
});

test("expansion adds informational issues and each detail beneath its own message", () => {
  const rows = render(issues, 100, true);
  const at = (text: string) => rows.findIndex((row) => row.includes(text));
  expect(at("Possible private key")).toBe(0);
  expect(at("The text to replace was not found")).toBe(1);
  expect(at("oldText was not found.")).toBe(2);
  expect(at("Match the original text")).toBe(3);
  expect(at("Showing lines 1-2000 of 9000")).toBe(4);
  expect(at("Use offset=2001 to continue.")).toBe(5);
  expect(rows).toHaveLength(6);
  // The message line itself is identical whether collapsed or expanded.
  expect(render(issues).every((row) => rows.includes(row))).toBe(true);
});

test("blank messages and empty lists render nothing", () => {
  expect(render([])).toEqual([]);
  expect(renderCompactIssues(undefined, theme, 100, true)).toEqual([]);
  expect(render([{ severity: "error", code: "blank", message: " \n\t" }], 100, true)).toEqual([]);
  expect(renderCompactIssues(issues, theme, 0, true)).toEqual([]);
});

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
  // Width 2 is the narrowest row that can hold a wide grapheme.
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
  expect(rows).toHaveLength(3);
});
