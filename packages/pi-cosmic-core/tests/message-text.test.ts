import { expect, test } from "@effect/vitest";
import {
  failureMessage,
  firstLineMessage,
  isAgentGuidance,
  MESSAGE_TEXT_LIMIT,
  notificationText,
  quoteText,
} from "../src/message-text.ts";

test("first-line messages are one bounded, inert, nonblank line", () => {
  expect(firstLineMessage("\n  \r\n  first\t\tline  \nsecond", "fallback")).toBe("first line");
  expect(firstLineMessage(" \n\t\n", "fallback")).toBe("fallback");
  expect(firstLineMessage("", "fallback")).toBe("fallback");
  const hostile = firstLineMessage("bad\u001b[2J escape", "fallback");
  expect(hostile).not.toContain("\u001b");
  expect(hostile).toMatch(/^bad.*escape$/u);
  expect(firstLineMessage("x".repeat(1000), "fallback")).toHaveLength(MESSAGE_TEXT_LIMIT);
});

test("first-line messages drop error-class wrappers and trailing agent advice", () => {
  for (const [text, expected] of [
    ["Error: 429 Too Many Requests", "429 Too Many Requests"],
    ["Uncaught TypeError: value is undefined", "value is undefined"],
    ["[ToolFailure] Nested tool 'bash' failed: gone", "Nested tool 'bash' failed: gone"],
    ["SchemaError(Expected no excess property", "Expected no excess property"],
    ["Found 2 matches in a.ts. Please provide more context.", "Found 2 matches in a.ts"],
    ["Guidance was accepted. Do not resend it.", "Guidance was accepted"],
    [
      "Protocol 21 is unsupported. Fell back to local/pi.",
      "Protocol 21 is unsupported. Fell back to local/pi",
    ],
    ["[REDACTED] token was rejected", "[REDACTED] token was rejected"],
  ] as const)
    expect(firstLineMessage(text, "fallback")).toBe(expected);
  expect(firstLineMessage("Error: ", "fallback")).toBe("fallback");
  expect(firstLineMessage('{"action":"tools.call","isError":true}', "fallback")).toBe("fallback");
  const clipped = firstLineMessage("word ".repeat(40), "fallback", 30);
  expect(clipped.length).toBeLessThanOrEqual(30);
});

test("quoted text keeps its full form as detail only when the line leaves something out", () => {
  expect(quoteText("Spawn failed.")).toEqual({ line: "Spawn failed" });
  expect(quoteText("Spawn  failed")).toEqual({ line: "Spawn failed" });
  expect(quoteText("Spawn failed\n  at spawn")).toEqual({
    line: "Spawn failed",
    detail: "Spawn failed\n  at spawn",
  });
  expect(quoteText("Review the server first.")).toEqual({ detail: "Review the server first." });
  expect(quoteText("  ")).toEqual({});
});

test("guidance is recognised by its opening instruction, not by later sentences", () => {
  expect(isAgentGuidance("Review external ownership before retrying.")).toBe(true);
  expect(isAgentGuidance("Error: Do not resend the guidance")).toBe(true);
  expect(isAgentGuidance("Docker is unavailable. Retry later.")).toBe(false);
  expect(isAgentGuidance("Reviewed 3 files")).toBe(false);
});

test("failure messages name common service and network failures from the first line only", () => {
  expect(failureMessage("Offset 401 is beyond end of file", "fallback")).toBe(
    "Offset 401 is beyond end of file",
  );
  expect(failureMessage("Build failed\nstatus 503", "fallback")).toBe("Build failed");
  expect(failureMessage("", "fallback")).toBe("fallback");
});

test("notifications are one tidy line, while multi-line reports keep their layout", () => {
  expect(notificationText("bad\u001b[2J escape")).not.toContain("\u001b");
  expect(notificationText(`{"data":"${"x".repeat(500)}"}`)).toHaveLength(511);
  const report = "Code Mode settings\n  enabled = true.";
  expect(notificationText(report)).toBe(report);
});
