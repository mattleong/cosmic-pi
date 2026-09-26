// Pure presentation-only projection of structured Code Mode output.
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { codeModeOutputText, formatStructuredCodeModeOutput } from "../src/ui/result-output.ts";

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

  it("keeps the plain fallback terminal-safe", () => {
    expect(codeModeOutputText("one\u001b]0;title\u0007\ntwo\u0007")).toBe("one\ntwo");
  });
});
