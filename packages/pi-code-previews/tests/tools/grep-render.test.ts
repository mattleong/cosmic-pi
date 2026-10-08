import assert from "node:assert/strict";
import { test } from "vitest";
import { parseGrepOutputLine, renderGrepOutputLines } from "../../src/tools/grep-render";
import { plainTheme } from "../support/render";

// Separators quoted inside the line text never extend the path or change the row's kind.
test.each([
  ["src/foo-1-bar.ts:42: const x = 1;", "src/foo-1-bar.ts", "42", "const x = 1;", "match"],
  ["src/foo-1-bar.ts-43- return x;", "src/foo-1-bar.ts", "43", "return x;", "context"],
  ["src/blank.ts:3: ", "src/blank.ts", "3", "", "match"],
  ["src/blank.ts-4- ", "src/blank.ts", "4", "", "context"],
  [
    "src/log.ts:12: error at foo.ts:40: boom",
    "src/log.ts",
    "12",
    "error at foo.ts:40: boom",
    "match",
  ],
  ["src/log.ts-13- see b.ts:2: here", "src/log.ts", "13", "see b.ts:2: here", "context"],
  ["src/a:b-1-c.ts:7: x-2- y", "src/a:b-1-c.ts", "7", "x-2- y", "match"],
] as const)("parseGrepOutputLine splits %j", (line, path, lineNumber, code, kind) => {
  assert.deepEqual(parseGrepOutputLine(line), { path, lineNumber, code, kind });
});

test("rows under bracketed route folders are file rows, not notices", () => {
  const notice = "[30 matches limit reached. Use limit=60 for more, or refine pattern]";
  const rendered = renderGrepOutputLines(
    `[slug]/page.tsx:12: const ids = [1, 2]\n${notice}`,
    plainTheme,
    {},
    undefined,
    false,
  );
  assert.equal(rendered.length, 3);
  assert.equal(rendered[0], "[slug]/page.tsx");
  assert.match(rendered[1] ?? "", /12 .* const ids = \[1, 2\]$/u);
  assert.equal(rendered[2], notice);
});

test("case-insensitive matches highlight their own text after length-changing letters", () => {
  const [, row = ""] = renderGrepOutputLines(
    "a.txt:1: İİ FOO",
    plainTheme,
    { pattern: "foo", literal: true, ignoreCase: true },
    undefined,
    false,
  );
  // Plain styling leaves the match highlight as the row's only escape sequences.
  assert.equal(row.split("\u001b[")[1]?.replace(/^[\d;]*m/u, ""), "FOO");
});
