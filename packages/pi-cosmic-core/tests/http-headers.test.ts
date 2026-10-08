import { expect, it } from "vitest";
import { mergeHeaders } from "../index.ts";

it("merges case-insensitively with the last value and casing without moving replaced entries", () => {
  const first = Object.freeze({ "X-First": "old", "X-Second": "second" });
  const last = Object.freeze({ "x-FIRST": "new", "X-Third": "third" });
  expect(Object.entries(mergeHeaders(undefined, first, undefined, last))).toEqual([
    ["x-FIRST", "new"],
    ["X-Second", "second"],
    ["X-Third", "third"],
  ]);
});

it("deletes null headers and appends headers restored after deletion", () => {
  expect(
    Object.entries(
      mergeHeaders(
        { "X-First": "old", "X-Second": "second", "X-Removed": "remove" },
        { "x-first": null, "x-removed": null, "X-Missing": null },
        { "X-FIRST": "restored", "X-Empty": "" },
      ),
    ),
  ).toEqual([
    ["X-Second", "second"],
    ["X-FIRST", "restored"],
    ["X-Empty", ""],
  ]);
  expect(mergeHeaders(undefined, { "X-Missing": null })).toEqual({});
});
