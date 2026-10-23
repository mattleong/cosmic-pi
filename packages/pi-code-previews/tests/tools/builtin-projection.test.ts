import { describe, expect, it } from "vitest";
import {
  projectBuiltinCompactSummary,
  type BuiltinCompactProjectionInput,
} from "../../src/tools/builtin-projection";
import type { BuiltinCompactTool } from "../../src/tools/builtin-subject";
import { issueMessageStyleProblems } from "../../src/testing/issue-messages";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Option from "effect/Option";

const base: BuiltinCompactProjectionInput = {
  phase: "settled",
  args: { path: "file.ts", content: "hello" },
  result: { content: [{ type: "text", text: "Written" }], details: {} },
  cwd: "/workspace",
  isError: false,
  beforeWrite: { kind: "unknown" },
  secretWarnings: true,
  bashWarnings: true,
  secretScanChars: 8000,
  maxWriteDiffBytes: 100000,
  maxWriteDiffChangedLineCells: 10000,
};
function failed(tool: BuiltinCompactTool, text: string, overrides: Partial<typeof base> = {}) {
  return projectBuiltinCompactSummary(tool, {
    ...base,
    ...overrides,
    isError: true,
    result: { content: [{ type: "text", text }], details: overrides.result?.details ?? {} },
  });
}
const firstShellIssueMessage = (text: string) => failed("bash", text)?.issues?.[0]?.message;

describe("builtin issue style", () => {
  it("writes every failure and argument warning in the shared style", () => {
    const summaries = [
      failed("bash", "output\nCommand exited with code 1"),
      failed("bash", "output\nCommand timed out after 30 seconds"),
      failed("read", "ENOENT: no such file or directory, open '/workspace/a.ts'"),
      failed("read", "EACCES: permission denied, open '/workspace/a.ts'"),
      failed("read", "Offset 401 is beyond end of file (20 lines total)"),
      failed(
        "edit",
        "Could not find the exact text in /workspace/a.ts. The old text must match exactly including all whitespace and newlines.",
      ),
      failed(
        "edit",
        "Found 2 occurrences of the text in /workspace/a.ts. The text must be unique. Please provide more context to make it unique.",
      ),
      failed("write", "Error: Could not write file.\n  at stack"),
      projectBuiltinCompactSummary("bash", { ...base, args: { command: "rm -rf build" } }),
      projectBuiltinCompactSummary("write", {
        ...base,
        args: {
          path: "a.env",
          content: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        },
      }),
    ];
    const issues = Arr.flatMap(summaries, (summary) => summary?.issues ?? []);
    expect(issues.length).toBeGreaterThanOrEqual(summaries.length);
    for (const { message } of issues)
      expect({ message, problems: issueMessageStyleProblems(message) }).toEqual({
        message,
        problems: [],
      });
  });
});

describe("builtin failure classification", () => {
  it("classifies only the terminal shell status and adds one bounded cause line", () => {
    const exit = failed(
      "bash",
      "SOURCE_SNIPPET\nError: diagnostic\n  at stack\nCommand exited with code 7",
    );
    expect(exit?.outcome).toBe("error");
    expect(exit?.issues).toEqual([
      { severity: "error", code: "shell-exit", message: "Exited with code 7: diagnostic" },
    ]);
    for (const [output, cause] of [
      [" FAIL  tests/a.test.ts > adds\n Test Files  1 failed (1)", "FAIL tests/a.test.ts > adds"],
      ["Traceback (most recent call last):\nValueError: bad input", "bad input"],
      [
        "src/auth/token.ts(42,7): error TS2322: Type 'x' is not assignable",
        "token.ts:42 Type 'x' is not assignable",
      ],
      ["error[E0308]: mismatched types", "mismatched types"],
      ["npm ERR! code ELIFECYCLE\n ELIFECYCLE  Test failed.", undefined],
      ["Found 0 errors. Watching for file changes.", undefined],
      ["building…\ndone", undefined],
    ] as const) {
      const message = firstShellIssueMessage(`${output}\nCommand exited with code 1`);
      expect(message).toBe(cause ? `Exited with code 1: ${cause}` : "Exited with code 1");
    }
    expect(firstShellIssueMessage("Command exited with code 127")).toBe(
      "Exited with code 127: command not found",
    );
    expect(firstShellIssueMessage("sh: foo: command not found\nCommand exited with code 127")).toBe(
      "Exited with code 127: command not found",
    );
    expect(firstShellIssueMessage("Error: out of heap\nCommand exited with code 137")).toBe(
      "Exited with code 137: out of heap",
    );
    const secret = firstShellIssueMessage("error: token=hunter2secret\nCommand exited with code 1");
    expect(secret).not.toContain("hunter2secret");
    expect(secret).toContain("[REDACTED]");
    expect(
      firstShellIssueMessage(`error: ${Fn.pipe("x", Str.repeat(200))}\nCommand exited with code 1`)
        ?.length,
    ).toBeLessThanOrEqual(70);
    expect(failed("bash", "partial output\nCommand timed out after 30 seconds")?.issues).toEqual([
      { severity: "error", code: "shell-timeout", message: "Timed out after 30 seconds" },
    ]);
    const unknown = failed("bash", "Command exited with code 7\nunknown tail");
    expect(unknown?.outcome).toBe("error");
    expect(
      Option.fromUndefinedOr(unknown?.issues).pipe(
        Option.map((issues) => Arr.map(issues, ({ code }) => code)),
        Option.getOrUndefined,
      ),
    ).toEqual(["failure"]);
    expect(JSON.stringify(unknown)).not.toContain("unknown tail");
    expect(failed("bash", "stdout\n\nCommand aborted")).toMatchObject({
      outcome: "cancelled",
      issues: [],
    });
  });
});

describe("builtin projection policy", () => {
  it("uses explicit secret policy and does not mutate retained inputs", () => {
    const input = Object.freeze({
      ...base,
      args: Object.freeze({ path: "file.ts", content: "-----BEGIN PRIVATE KEY-----" }),
      beforeWrite: { kind: "new" as const },
    });
    const warned = projectBuiltinCompactSummary("write", input);
    expect(warned?.outcome).toBe("warning");
    expect(warned?.issues).toEqual([
      expect.objectContaining({ severity: "warning", code: "possible-secrets" }),
    ]);
    expect(
      projectBuiltinCompactSummary("write", { ...input, secretWarnings: false }),
    ).toMatchObject({ outcome: "success", issues: [] });
  });
});
