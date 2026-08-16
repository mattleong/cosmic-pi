// Pure presentation-only projection of structured Code Mode output.
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  codeModeOutputText,
  MAX_STRUCTURED_OUTPUT_FIELDS,
  projectStructuredCodeModeOutput,
} from "../src/ui/result-output.ts";

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
