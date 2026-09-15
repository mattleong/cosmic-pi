import { expect, test } from "vitest";
import {
  editResultDetail,
  grepResultDetail,
  writeResultDetail,
} from "../../src/tools/builtin-result-detail";

test("edit totals require every operation to be valid and changed", () => {
  const operation = { oldText: "old", newText: "new" };
  expect(editResultDetail({ edits: [operation, operation] })).toMatch(/2/);
  for (const edits of [
    [],
    [operation, {}],
    [{ oldText: "x", newText: "x" }],
    Array.from({ length: 65 }, () => ({ ...operation })),
  ])
    expect(editResultDetail({ edits })).toBeUndefined();
});

test("grep counts matching lines only for complete recognizable output", () => {
  expect(grepResultDetail("a.ts:1: twice twice\na.ts-2- context\na.ts:3: match\n", {})).toMatch(
    /2/,
  );
  for (const details of [
    { linesTruncated: true },
    { matchLimitReached: 2 },
    { truncation: { truncated: true } },
  ])
    expect(grepResultDetail("a.ts:1: match", details)).toBeUndefined();
  for (const output of [
    "",
    "unknown output",
    "a.ts:1: match\n[output clipped]",
    "a.ts:1: hit\na.ts-2- message b.ts:3: context",
    "a.ts:1: message b.ts-3- context",
  ])
    expect(grepResultDetail(output, {})).toBeUndefined();
});

test("write counts require bounded known contents and never infer missing history", () => {
  expect(writeResultDetail({ kind: "content", content: "a\nb\n" }, "a\nc\n")).toMatch(/\+1\/-1/);
  for (const before of [undefined, {}, { kind: "skipped", reason: "size" }])
    expect(writeResultDetail(before, "new")).toBeUndefined();
  expect(
    writeResultDetail({ kind: "content", content: "old" }, "x".repeat(65_000)),
  ).toBeUndefined();
});
