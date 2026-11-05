import { expect, test } from "@effect/vitest";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { failureMessage, firstLineMessage, MESSAGE_TEXT_LIMIT } from "../src/message-text.ts";

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

test.each([
  ["Error: 429 Too Many Requests: rate limit exceeded\n    at Client.request", "Rate limited"],
  ["Prompt rejected: 400 invalid_request_error: messages.0.content is empty", "Prompt was empty"],
  ["Prompt rejected: 400 invalid_request_error: max_tokens too large", "Request rejected"],
])("failureMessage turns a provider diagnostic into a short human cause", (raw, cause) => {
  const message = failureMessage(raw, "failed");
  expect(message).toContain(cause);
  expect(message).not.toContain("invalid_request_error");
  expect(message).not.toContain("Client.request");
});

test("a long failure message ends at a whole word", () => {
  const raw = `Provider rejected the session: ${Fn.pipe("quota detail ", Str.repeat(40))}`;
  const message = failureMessage(raw, "failed", 120);
  expect(message.length).toBeLessThanOrEqual(120);
  expect(message).toMatch(/ (?:quota|detail)…$/u);
});
