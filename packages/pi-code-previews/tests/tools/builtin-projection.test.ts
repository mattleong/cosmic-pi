import { describe, expect, it } from "vitest";
import {
  projectBuiltinCompactSummary,
  type BuiltinCompactProjectionInput,
} from "../../src/tools/builtin-projection";
import type { BuiltinCompactTool } from "../../src/tools/builtin-subject";
import { CORE_CODE_PREVIEW_TOOLS } from "../../src/tools/names";
import { issueMessageStyleProblems } from "../../src/testing/issue-messages";

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
    const issues = summaries.flatMap((summary) => summary?.issues ?? []);
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
    // The first failure line says why; other output and stack frames stay expanded-only.
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
      const message = failed("bash", `${output}\nCommand exited with code 1`)?.issues?.[0]?.message;
      expect(message).toBe(cause ? `Exited with code 1: ${cause}` : "Exited with code 1");
    }
    // Without a failure line, a conventional exit code says what happened; an output line wins.
    expect(failed("bash", "Command exited with code 127")?.issues?.[0]?.message).toBe(
      "Exited with code 127: command not found",
    );
    expect(
      failed("bash", "sh: foo: command not found\nCommand exited with code 127")?.issues?.[0]
        ?.message,
    ).toBe("Exited with code 127: command not found");
    expect(
      failed("bash", "Error: out of heap\nCommand exited with code 137")?.issues?.[0]?.message,
    ).toBe("Exited with code 137: out of heap");
    const secret = failed("bash", "error: token=hunter2secret\nCommand exited with code 1");
    expect(secret?.issues?.[0]?.message).not.toContain("hunter2secret");
    expect(secret?.issues?.[0]?.message).toContain("[REDACTED]");
    expect(
      failed("bash", `error: ${"x".repeat(200)}\nCommand exited with code 1`)?.issues?.[0]?.message
        .length,
    ).toBeLessThanOrEqual(70);
    expect(failed("bash", "partial output\nCommand timed out after 30 seconds")?.issues).toEqual([
      { severity: "error", code: "shell-timeout", message: "Timed out after 30 seconds" },
    ]);
    // A status line followed by more text is not the builtin's terminal status.
    const unknown = failed("bash", "Command exited with code 7\nunknown tail");
    expect(unknown?.outcome).toBe("error");
    expect(unknown?.issues?.map(({ code }) => code)).toEqual(["failure"]);
    expect(JSON.stringify(unknown)).not.toContain("unknown tail");
    expect(failed("bash", "stdout\n\nCommand aborted")).toMatchObject({
      outcome: "cancelled",
      issues: [],
    });
  });

  it("keeps the retained-output location from thrown shell errors", () => {
    const footer = "Showing lines 10-20 of 20. Full output: /tmp/failure-log.txt";
    const value = failed("bash", `ordinaryDiagnostic\n\n[${footer}]\n\nCommand exited with code 7`);
    expect(value?.issues).toContainEqual(
      expect.objectContaining({ severity: "info", message: footer }),
    );
    expect(JSON.stringify(value)).not.toContain("ordinaryDiagnostic");
    // Only Pi's footer position is recovery evidence; the same text earlier is just output.
    const printed = failed("bash", `[${footer}]\nlater output\n\nCommand exited with code 7`);
    expect(printed?.issues?.map(({ code }) => code)).toEqual(["shell-exit"]);
  });

  it.each(CORE_CODE_PREVIEW_TOOLS)(
    "%s treats a bare abort as cancellation without an issue",
    (tool) => {
      expect(failed(tool, "Operation aborted")).toMatchObject({ outcome: "cancelled", issues: [] });
      // More text means the host reported something beyond a plain abort.
      const value = failed(tool, "Operation aborted\nInspect the file before retrying.");
      expect(value?.outcome).toBe("error");
      expect(JSON.stringify(value?.issues)).not.toContain("Inspect the file");
    },
  );

  it.each([
    ["read", "ENOENT: no such file or directory, access '/secret/path.ts'", "File not found"],
    ["read", "EACCES: permission denied, open '/secret/path.ts'", "Permission denied"],
    ["read", "Path not found: /secret/path.ts", "Path not found"],
    ["edit", "Could not edit file: /secret/path.ts. Error code: ENOENT.", "File not found"],
    ["edit", "Could not edit file: /secret/path.ts. Error code: EACCES.", "Permission denied"],
  ] as const)("%s filesystem error %s is described without its path", (tool, text, message) => {
    const value = failed(tool, `${text}\nInspect parent permissions before retrying.`);
    expect(value?.outcome).toBe("error");
    expect(value?.issues).toEqual([{ severity: "error", code: "filesystem", message }]);
    expect(JSON.stringify(value?.issues)).not.toMatch(/secret\/path|Inspect parent/u);
  });

  it("describes edit refusals without leaking paths or source text", () => {
    for (const [text, code, detail] of [
      [
        "Found 4 occurrences of edits[3] in secret-file. Each oldText must be unique. Please provide more context to make it unique.",
        "edit-ambiguous",
        "edits[3].oldText",
      ],
      [
        "Could not find edits[2] in secret-file. The oldText must match exactly including all whitespace and newlines.",
        "edit-no-match",
        "edits[2].oldText",
      ],
      [
        "Could not find the exact text in secret-file. The old text must match exactly including all whitespace and newlines.",
        "edit-no-match",
        "oldText",
      ],
      [
        "edits[0] and edits[1] overlap in secret-file. Merge them into one edit or target disjoint regions.",
        "edit-overlap",
        "edits[0] and edits[1]",
      ],
      [
        "No changes made to secret-file. The replacements produced identical content.",
        "edit-unchanged",
        "",
      ],
      [
        "No changes made to secret-file. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.",
        "edit-unchanged",
        "",
      ],
      ["oldText must not be empty in secret-file.", "edit-empty", "oldText"],
      ["edits[1].oldText must not be empty in secret-file.", "edit-empty", "edits[1].oldText"],
    ] as const) {
      const value = failed("edit", text);
      expect(value?.outcome).toBe("error");
      expect(value?.issues).toHaveLength(1);
      expect(value?.issues?.[0]).toMatchObject({ severity: "error", code });
      expect(value?.issues?.[0]?.detail ?? "").toContain(detail);
      expect(JSON.stringify(value?.issues)).not.toContain("secret-file");
    }
  });

  it("describes unrecognised errors by their first line only", () => {
    const value = failed("write", "Write failed.\nInspect filesystem state.");
    expect(value?.issues).toEqual([
      { severity: "error", code: "failure", message: "Write failed" },
    ]);
    const empty = failed("read", "");
    expect(empty?.outcome).toBe("error");
    expect(empty?.issues?.[0]?.message).toBeTruthy();
  });

  it("keeps input warnings and output limits beside the failure, naming saved output once", () => {
    const footer = "[Showing lines 1-2 of 9. Full output: /tmp/bash-full.txt]";
    const value = failed("bash", `${footer}\n\nCommand exited with code 1`, {
      args: { command: "rm -rf build" },
      result: {
        content: [],
        details: { truncation: { truncated: true }, fullOutputPath: "/tmp/bash-full.txt" },
      },
    });
    expect(value?.outcome).toBe("error");
    expect(value?.issues?.map(({ code }) => code)).toEqual([
      "shell-exit",
      "command-risk-0",
      "output-truncated",
      "retained-output",
    ]);
    expect(value?.issues?.at(-1)?.message).toContain("/tmp/bash-full.txt");
  });

  it("declines attachments rather than summarising part of the output", () => {
    const image = projectBuiltinCompactSummary("read", {
      ...base,
      isError: true,
      result: { content: [{ type: "image", mimeType: "image/png", data: "AAAA" }], details: {} },
    });
    expect(image).toBeUndefined();
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

describe("write and edit history", () => {
  it("reports failed snapshot history as information, not a problem with the write", () => {
    const failedSnapshot = projectBuiltinCompactSummary("write", {
      ...base,
      beforeWrite: {
        kind: "snapshot",
        value: { kind: "skipped", reason: "previous content unavailable", maxBytes: 100_000 },
      },
    });
    expect(failedSnapshot?.outcome).toBe("success");
    expect(failedSnapshot?.issues).toEqual([
      expect.objectContaining({ severity: "info", code: "write-diff-skipped" }),
    ]);
  });

  it("does not hide secret or write-failure attention behind unavailable diffs", () => {
    const secret = projectBuiltinCompactSummary("write", {
      ...base,
      args: { path: "file.ts", content: "-----BEGIN PRIVATE KEY-----" },
    });
    expect(secret?.outcome).toBe("warning");
    expect(secret?.issues?.map(({ code }) => code)).toContain("possible-secrets");
    const edit = projectBuiltinCompactSummary("edit", {
      ...base,
      args: { path: "file.ts", oldText: "before", newText: "after" },
    });
    expect(edit?.outcome).toBe("success");
    expect(edit?.issues).toEqual([
      expect.objectContaining({ severity: "info", code: "edit-diff-unavailable" }),
    ]);
    const writeFailure = failed("write", "Write failed.");
    expect(writeFailure?.outcome).toBe("error");
    expect(writeFailure?.issues?.map(({ code }) => code)).toEqual(["failure"]);
  });
});
