import { expect, test } from "@effect/vitest";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { firstLineMessage, MESSAGE_TEXT_LIMIT } from "../src/message-text.ts";

test("first-line messages are one bounded, inert, nonblank line", () => {
  expect(firstLineMessage("\n  \r\n  first\t\tline  \nsecond", "fallback")).toBe("first line");
  expect(firstLineMessage(" \n\t\n", "fallback")).toBe("fallback");
  expect(firstLineMessage("", "fallback")).toBe("fallback");
  const hostile = firstLineMessage("bad\u001b[2J escape", "fallback");
  expect(hostile).not.toContain("\u001b");
  expect(hostile).toMatch(/^bad.*escape$/u);
  expect(firstLineMessage(Fn.pipe("x", Str.repeat(1000)), "fallback")).toHaveLength(
    MESSAGE_TEXT_LIMIT,
  );
});
