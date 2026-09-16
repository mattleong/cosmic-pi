// Pure presentation-only projection of structured Code Mode output.
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  codeModeOutputText,
  formatStructuredCodeModeOutput,
  MAX_STRUCTURED_OUTPUT_FIELDS,
  projectStructuredCodeModeOutput,
} from "../src/ui/result-output.ts";

describe("formatStructuredCodeModeOutput", () => {
  it.each([{ characters: 50945 }, [1, { name: "value" }], true, null, 42, "value"])(
    "formats canonical structured values without changing their meaning: %j",
    (value) => {
      const text = JSON.stringify(value);
      const formatted = formatStructuredCodeModeOutput(text);
      expect(formatted).toBe(JSON.stringify(value, null, 2));
      expect(JSON.parse(formatted!)).toEqual(value);
      expect(formatStructuredCodeModeOutput(formatted!)).toBe(formatted);
      expect(text).toBe(JSON.stringify(value));
    },
  );

  it("preserves logs except terminal controls, including extra log separators", () => {
    const logs = "first\n\nLogs:\nsecond\u001b[31m\n";
    expect(formatStructuredCodeModeOutput('{"characters":50945}\n\nLogs:\n' + logs)).toBe(
      '{\n  "characters": 50945\n}\n\nLogs:\nfirst\n\nLogs:\nsecond\n',
    );
  });

  it.each([
    '{"a":1,"a":2}',
    '{"n":9007199254740993}',
    '{"n":1e20}',
    '{"2":2,"1":1}',
    '{ "a": 1 }',
    '{"truncated":',
    "plain text",
    "-0",
  ])("leaves ambiguous or noncanonical text to the plain fallback: %s", (text) => {
    expect(formatStructuredCodeModeOutput(text)).toBeUndefined();
    expect(codeModeOutputText(text)).toBe(text);
  });

  it("bounds input, depth, nodes, and whitespace expansion", () => {
    expect(formatStructuredCodeModeOutput(JSON.stringify("x".repeat(65536)))).toBeUndefined();
    expect(formatStructuredCodeModeOutput(JSON.stringify("界".repeat(24000)))).toBeUndefined();
    expect(formatStructuredCodeModeOutput("[".repeat(21) + "0" + "]".repeat(21))).toBeUndefined();
    expect(formatStructuredCodeModeOutput(JSON.stringify(Array(2001).fill(0)))).toBeUndefined();
    const broad = Array.from({ length: 1800 }, () => "x".repeat(30));
    let deep: Schema.Json = broad;
    for (let index = 0; index < 18; index += 1) deep = [deep];
    expect(formatStructuredCodeModeOutput(JSON.stringify(deep))).toBeUndefined();
  });
});

describe("projectStructuredCodeModeOutput", () => {
  it("projects only small top-level objects with at least one multiline string", () => {
    expect(projectStructuredCodeModeOutput(JSON.stringify(["one\ntwo"]))).toBeUndefined();
    expect(projectStructuredCodeModeOutput(JSON.stringify({ status: "one line" }))).toBeUndefined();
    expect(projectStructuredCodeModeOutput("truncated {")).toBeUndefined();

    const tooMany = Object.fromEntries(
      Array.from({ length: MAX_STRUCTURED_OUTPUT_FIELDS + 1 }, (_, index) => [
        `field-${index}`,
        index === 0 ? "one\ntwo" : "value",
      ]),
    );
    expect(projectStructuredCodeModeOutput(JSON.stringify(tooMany))).toBeUndefined();
  });

  it("sanitizes decoded field labels, bodies, and appended logs", () => {
    const projected = projectStructuredCodeModeOutput(
      `${JSON.stringify({
        "safe\u001b]0;title\u0007 label": "one\u001b[2J\ntwo\u0007",
        other: "plain",
      })}\n\nLogs:\nlog\u001b[31m line`,
    );
    expect(projected).toEqual([
      { label: "safe label", body: "one\ntwo" },
      { label: "other", body: "plain" },
      { label: "Logs", body: "log line" },
    ]);
  });

  it("rejects mixed or noncanonical JSON instead of amplifying or omitting content", () => {
    let deep: Schema.Json = "leaf";
    for (let index = 0; index < 30; index += 1) deep = [deep];
    expect(
      projectStructuredCodeModeOutput(JSON.stringify({ multiline: "one\ntwo", deep })),
    ).toBeUndefined();
    expect(
      projectStructuredCodeModeOutput('{"status":"one\\ntwo","status":"replacement\\nvalue"}'),
    ).toBeUndefined();
    expect(projectStructuredCodeModeOutput('{ "status" : "one\\ntwo" }')).toBeUndefined();
    expect(projectStructuredCodeModeOutput('{"status":"one\\ntwo","number":1e20}')).toBeUndefined();
  });

  it("rejects labels made ambiguous by sanitization, truncation, or runtime logs", () => {
    expect(
      projectStructuredCodeModeOutput(
        JSON.stringify({ "safe\u001b[31m": "one\ntwo", safe: "other" }),
      ),
    ).toBeUndefined();
    expect(
      projectStructuredCodeModeOutput(
        `${JSON.stringify({ Logs: "one\ntwo" })}\n\nLogs:\nruntime log`,
      ),
    ).toBeUndefined();
  });

  it("keeps the plain fallback terminal-safe", () => {
    expect(codeModeOutputText("one\u001b]0;title\u0007\ntwo\u0007")).toBe("one\ntwo");
  });
});
