import assert from "node:assert/strict";
import { test } from "vitest";
import { parseGrepOutputLine } from "../../src/tools/grep-render";

test.each([
  ["src/foo-1-bar.ts:42: const x = 1;", "src/foo-1-bar.ts", "42", "const x = 1;", "match"],
  ["src/log.ts-13- see b.ts:2: here", "src/log.ts", "13", "see b.ts:2: here", "context"],
  ["src/a:b-1-c.ts:7: x-2- y", "src/a:b-1-c.ts", "7", "x-2- y", "match"],
] as const)("parseGrepOutputLine splits %j", (line, path, lineNumber, code, kind) => {
  assert.deepEqual(parseGrepOutputLine(line), { path, lineNumber, code, kind });
});
