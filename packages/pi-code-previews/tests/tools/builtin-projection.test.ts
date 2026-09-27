import { describe, expect, it } from "vitest";
import {
  projectBuiltinCompactSummary,
  type BuiltinCompactProjectionInput,
} from "../../src/tools/builtin-projection";
import type { BuiltinCompactTool } from "../../src/tools/builtin-subject";
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
const tools: BuiltinCompactTool[] = ["read", "bash", "write", "edit", "grep", "find", "ls"];

function failed(tool: BuiltinCompactTool, text: string, overrides: Partial<typeof base> = {}) {
  return projectBuiltinCompactSummary(tool, {
    ...base,
    ...overrides,
    isError: true,
    result: { content: [{ type: "text", text }], details: overrides.result?.details ?? {} },
  });
}
const codes = (tool: BuiltinCompactTool, input: Partial<BuiltinCompactProjectionInput>) =>
  projectBuiltinCompactSummary(tool, { ...base, ...input })?.issues?.map(({ code }) => code);

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
  it("classifies only the terminal shell status and never repeats output", () => {
    const exit = failed(
      "bash",
      "SOURCE_SNIPPET\nError: diagnostic\n  at stack\nCommand exited with code 7",
    );
    expect(exit?.outcome).toBe("error");
    expect(exit?.issues).toEqual([
      { severity: "error", code: "shell-exit", message: "Exited with code 7" },
    ]);
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
  });

  it.each(tools)("%s treats a bare abort as cancellation without an issue", (tool) => {
    expect(failed(tool, "Operation aborted")).toMatchObject({ outcome: "cancelled", issues: [] });
    // More text means the host reported something beyond a plain abort.
    const value = failed(tool, "Operation aborted\nInspect the file before retrying.");
    expect(value?.outcome).toBe("error");
    expect(JSON.stringify(value?.issues)).not.toContain("Inspect the file");
  });

  it.each([
    ["ENOENT: no such file or directory, access '/secret/path.ts'", "File not found"],
    ["EACCES: permission denied, open '/secret/path.ts'", "Permission denied"],
    ["Path not found: /secret/path.ts", "Path not found"],
  ])("filesystem error %s is described without its path", (text, message) => {
    const value = failed("read", `${text}\nInspect parent permissions before retrying.`);
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

  it("keeps input warnings and output limits beside the failure", () => {
    const value = failed("bash", "Command exited with code 1", {
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

  it("declines attachments and over-budget output rather than summarising part of it", () => {
    const image = projectBuiltinCompactSummary("read", {
      ...base,
      isError: true,
      result: { content: [{ type: "image", mimeType: "image/png", data: "AAAA" }], details: {} },
    });
    expect(image).toBeUndefined();
    expect(failed("bash", "x".repeat(128 * 1024 + 1))).toBeUndefined();
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
  it("reports intentionally uncaptured history as information only", () => {
    const value = projectBuiltinCompactSummary("write", {
      ...base,
      beforeWrite: { kind: "not-captured" },
    });
    expect(value?.outcome).toBe("success");
    expect(value?.issues).toEqual([
      expect.objectContaining({ severity: "info", code: "write-diff-not-captured" }),
    ]);
  });

  it("reports unknown and failed snapshot history as information, not a problem with the write", () => {
    expect(codes("write", {})).toEqual(["write-history-unavailable"]);
    expect(projectBuiltinCompactSummary("write", base)?.outcome).toBe("success");
    expect(projectBuiltinCompactSummary("write", base)?.issues?.[0]?.severity).toBe("info");
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
      beforeWrite: { kind: "not-captured" },
    });
    expect(secret?.outcome).toBe("warning");
    expect(secret?.issues?.map(({ code }) => code)).toContain("possible-secrets");
    const edit = projectBuiltinCompactSummary("edit", {
      ...base,
      args: { path: "file.ts", oldText: "before", newText: "after" },
      beforeWrite: { kind: "not-captured" },
    });
    expect(edit?.outcome).toBe("success");
    expect(edit?.issues).toEqual([
      expect.objectContaining({ severity: "info", code: "edit-diff-unavailable" }),
    ]);
    const writeFailure = failed("write", "Write failed.", {
      beforeWrite: { kind: "not-captured" },
    });
    expect(writeFailure?.outcome).toBe("error");
    expect(writeFailure?.issues?.map(({ code }) => code)).toEqual(["failure"]);
  });
});
