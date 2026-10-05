import assert from "node:assert/strict";
import { test } from "vitest";
import { parseGrepOutputLine } from "../../src/tools/grep-render";

test("parseGrepOutputLine handles hyphenated filenames, context lines, and empty matches", () => {
  for (const [line, path, lineNumber, code, kind] of [
    ["src/foo-1-bar.ts:42: const x = 1;", "src/foo-1-bar.ts", "42", "const x = 1;", "match"],
    ["src/foo-1-bar.ts-43- return x;", "src/foo-1-bar.ts", "43", "return x;", "context"],
    ["src/blank.ts:3: ", "src/blank.ts", "3", "", "match"],
    ["src/blank.ts-4- ", "src/blank.ts", "4", "", "context"],
  ] as const) {
    assert.deepEqual(parseGrepOutputLine(line), { path, lineNumber, code, kind });
  }
});

test("parseGrepOutputLine splits at the first separator when the text quotes another", () => {
  for (const [line, path, lineNumber, code, kind] of [
    [
      "src/log.ts:12: error at foo.ts:40: boom",
      "src/log.ts",
      "12",
      "error at foo.ts:40: boom",
      "match",
    ],
    ["src/log.ts-13- see b.ts:2: here", "src/log.ts", "13", "see b.ts:2: here", "context"],
    ["src/a:b-1-c.ts:7: x-2- y", "src/a:b-1-c.ts", "7", "x-2- y", "match"],
  ] as const) {
    assert.deepEqual(parseGrepOutputLine(line), { path, lineNumber, code, kind });
  }
});
