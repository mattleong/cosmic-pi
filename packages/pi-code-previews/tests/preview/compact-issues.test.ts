import { expect, test } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderCompactIssues } from "../../src/preview/compact-issues";
import type { CompactIssue } from "../../src/tools/compact-issues";
import { plainTheme as theme, stripAnsi } from "../support/render";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";

const render = (value: readonly CompactIssue[], width = 100, expanded = false) =>
  Arr.map(renderCompactIssues(value, theme, width, expanded), stripAnsi);
const squash = (rows: readonly string[]) => Fn.pipe(Arr.join(rows, ""), Str.replace(/\s/gu, ""));

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
      expect(Arr.every(rows, (row) => visibleWidth(row) <= width)).toBe(true);
      const text = squash(rows);
      for (const expected of expanded
        ? [long[0]!.message, ...Str.split(long[0]!.detail!, "\n"), long[1]!.message]
        : [long[0]!.message])
        expect(text).toContain(Fn.pipe(expected, Str.replace(/\s/gu, "")));
      expect(Fn.pipe(text, Str.includes("Continue"))).toBe(expanded);
    }
  expect(Arr.every(render(long, 1, true), (row) => visibleWidth(row) <= 1)).toBe(true);
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
  expect(Arr.join(rows, "")).not.toContain("\u001b[2J");
  expect(stripAnsi(rows[0]!)).toMatch(/first second.*third/u);
});

test("attention issues show collapsed with the same message as expanded", () => {
  const asks: CompactIssue[] = [
    {
      severity: "attention",
      code: "question",
      message: "worker asks: Which seed file?",
      detail: "The whole question",
    },
    { severity: "info", code: "hint", message: "Page 1 of 2" },
  ];
  const collapsed = squash(render(asks));
  const expanded = squash(render(asks, 100, true));
  const message = Fn.pipe(asks[0]!.message, Str.replace(/\s/gu, ""));
  expect(collapsed).toContain(message);
  expect(expanded).toContain(message);
  expect(Fn.pipe(collapsed, Str.includes("Thewholequestion"))).toBe(false);
  expect(expanded).toContain("Thewholequestion");
  expect(Fn.pipe(collapsed, Str.includes("Page1"))).toBe(false);
});

test("expanded detail that only repeats its message is shown once", () => {
  const issue: CompactIssue = {
    severity: "error",
    code: "disabled",
    message: "Image generation is disabled in config",
    detail: "Image generation is disabled in config.",
  };
  const rows = render([issue], 100, true);
  expect(Arr.filter(rows, Str.includes("disabled in config"))).toHaveLength(1);
  const distinct = render([{ ...issue, detail: "Set image.enabled to true" }], 100, true);
  expect(Arr.some(distinct, Str.includes("image.enabled"))).toBe(true);
});

test("expanded detail breaks a long path after its last directory before inside the file name", () => {
  const file = "agent-1-1-4f1c.md";
  const rows = render(
    [
      {
        severity: "info",
        code: "saved",
        message: "auth-review: full report saved to a file",
        detail: `28,200 of 152,310 characters kept. Report file: ~/.pi/agent/subagents/reports/session-1/${file} · 152,310 characters, 3,172 lines`,
      },
    ],
    57,
    true,
  );
  expect(Arr.every(rows, (row) => visibleWidth(row) <= 57)).toBe(true);
  expect(Arr.some(rows, (row) => Fn.pipe(Str.trim(row), Str.endsWith("session-1/")))).toBe(true);
  expect(Arr.some(rows, Str.includes(file))).toBe(true);
});

const indent = (row: string) => row.length - Str.trimStart(row).length;

test("a wrapped detail line's continuation hangs past the next detail line's start", () => {
  const rows = render(
    [
      {
        severity: "info",
        code: "saved",
        message: "auth-review: full report saved to a file",
        detail:
          "Failure file: ~/.pi/agent/agent-1-1-failure.md · 420 characters, 1 line\nNext line",
      },
    ],
    50,
    true,
  );
  const continuation = Arr.findFirst(rows, (row) => Str.startsWith("· 420")(Str.trimStart(row)));
  const next = Arr.findFirst(rows, (row) => Str.trim(row) === "Next line");
  expect(Option.map(continuation, indent)).toEqual(Option.map(next, (row) => indent(row) + 2));
  expect(Option.isSome(next)).toBe(true);
});
