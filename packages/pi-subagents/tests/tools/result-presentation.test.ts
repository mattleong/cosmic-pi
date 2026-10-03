import { issueMessageStyleProblems, renderContextFixture } from "pi-code-previews/testing";
import { describe, expect, it } from "vitest";
import { RESULT_ACCEPTED_TEXT, resultCompactSummary } from "../../src/tools/result-presentation.ts";

interface VerdictArguments {
  readonly verdict: string;
  readonly findings: ReadonlyArray<string>;
}

const VALUE: VerdictArguments = { verdict: "ok", findings: ["src/auth.ts"] };

function summarize(args: VerdictArguments, text?: string, isError = false) {
  return resultCompactSummary({
    args,
    phase: text === undefined ? "running" : "settled",
    result: text === undefined ? undefined : { content: [{ type: "text", text }], details: {} },
    context: renderContextFixture({ isError }),
  });
}

describe("child result compact summary", () => {
  it("heads the row with the submitted value and claims nothing while it is pending", () => {
    const pending = summarize(VALUE);
    expect(pending?.subject).toContain("src/auth.ts");
    expect(pending?.outcome).toBeUndefined();
  });

  it("is a success only for the exact acceptance receipt", () => {
    expect(summarize(VALUE, RESULT_ACCEPTED_TEXT)?.outcome).toBe("success");
    expect(summarize(VALUE, `${RESULT_ACCEPTED_TEXT} Then continue.`)).toBeUndefined();
  });

  it("explains a rejected value in people's terms and keeps the full text expanded", () => {
    const rejections = [
      'Validation failed for tool "subagent_result":\n  - verdict: must be equal to one of the allowed values',
      'The result does not match its schema:\nExpected string\n  at ["verdict"]',
      "A result was already accepted for this run, and the first one is final. Stop now.",
    ];
    for (const text of rejections) {
      const summary = summarize(VALUE, text, true);
      expect(summary?.outcome).toBe("error");
      const [issue] = summary?.issues ?? [];
      expect(issue?.severity).toBe("error");
      expect(issueMessageStyleProblems(issue?.message ?? "")).toEqual([]);
      expect(`${issue?.message}\n${issue?.detail ?? ""}`).toContain(text.split("\n")[0] ?? text);
    }
  });
});
