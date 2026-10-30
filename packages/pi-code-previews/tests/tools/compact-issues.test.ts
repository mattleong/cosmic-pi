import { describe, expect, test } from "vitest";
import {
  compactIssueSeverity,
  mergeCompactIssues,
  type CompactIssue,
} from "../../src/tools/compact-issues";
import { issueMessageStyleProblems } from "../../src/testing/issue-messages";
import {
  compactStatus,
  resolveCompactSummary,
  type CompactSummary,
} from "../../src/tools/compact-summary";
import * as Str from "effect/String";
import * as Option from "effect/Option";

const issue = (overrides: Partial<CompactIssue> = {}): CompactIssue => ({
  severity: "error",
  code: "remote-failure",
  message: "Element detached",
  ...overrides,
});
const info = issue({ severity: "info", code: "hint", message: "Page 1 of 2" });
const warning = issue({ severity: "warning", code: "cleanup", message: "Cleanup is unconfirmed" });
const attention = issue({
  severity: "attention",
  code: "question",
  message: "worker asks: Which API?",
});

describe("issue merging", () => {
  test("coalesces equal evidence in first-seen order and keeps every distinct detail line", () => {
    const first = issue({ detail: "Inspect state.\nKeep the log." });
    const repeat = issue({ detail: "Keep the log.\nDo not replay." });
    const sources = [[first, warning], undefined, [repeat, info]] as const;
    const before = JSON.stringify(sources);
    expect(mergeCompactIssues(...sources)).toEqual([
      { ...first, detail: "Inspect state.\nKeep the log.\nDo not replay." },
      warning,
      info,
    ]);
    expect(JSON.stringify(sources)).toBe(before);
    expect(mergeCompactIssues([issue()], [issue()])).toEqual([issue()]);
  });
});

test("the style guard flags machine text and accepts human messages", () => {
  for (const message of [
    "Unknown tool: Unknown tool 'pi.grepp'",
    "Invalid input: SchemaError(Expected string",
    "[ExecutionFailure] boom",
    "Program error (line 3): x (line 3, col 8)",
    'Reply with subagent_reply({ runId: "a" })',
    "Paused. Inspect status before retrying",
    "Worker failed.",
    "Worker agent-7 failed",
  ])
    expect({
      message,
      flagged: issueMessageStyleProblems(message, { forbidden: ["agent-7"] }).length > 0,
    }).toEqual({ message, flagged: true });
  for (const message of [
    "No tool named pi.grepp",
    "auth-review asks: Should I update the migration?",
    "Timed out after 100 ms (line 1)",
    'read: unexpected field "file"',
  ])
    expect({ message, problems: issueMessageStyleProblems(message) }).toEqual({
      message,
      problems: [],
    });
});

describe("summary resolution", () => {
  const base: CompactSummary = { subject: "work", outcome: "success" };

  test("a Pi error overrides claimed success and explains itself with its first line", () => {
    for (const outcome of ["success", "returned", "warning", "error"] as const) {
      const resolved = resolveCompactSummary(
        { ...base, outcome, issues: [info] },
        "settled",
        true,
        "\nRejected by host\nInternal stack",
      )!;
      expect(resolved.outcome).toBe("error");
      expect(resolved.issues?.[0]).toMatchObject({
        severity: "error",
        message: "Rejected by host",
      });
      expect(resolved.issues?.slice(1)).toEqual([info]);
      expect(JSON.stringify(resolved)).not.toContain("Internal stack");
      expect(compactStatus("settled", resolved)).toBe("error");
    }
    // A question awaiting a reply never explains or hides the failure.
    const asking = resolveCompactSummary(
      { ...base, issues: [attention] },
      "settled",
      true,
      "Rejected by host",
    )!;
    expect(asking.outcome).toBe("error");
    expect(asking.issues?.[0]).toMatchObject({ severity: "error", message: "Rejected by host" });
    expect(asking.issues).toContainEqual(attention);
    expect(compactStatus("settled", asking)).toBe("error");
    const unexplained = resolveCompactSummary(base, "settled", true, "")!;
    expect(unexplained.issues).toHaveLength(1);
    expect(unexplained.issues?.[0]?.severity).toBe("error");
    expect(
      Option.fromUndefinedOr(unexplained.issues?.[0]).pipe(
        Option.map((first) => Str.trim(first.message)),
        Option.getOrUndefined,
      ),
    ).not.toBe("");
  });
});

const status = (outcome: CompactSummary["outcome"], issues: CompactIssue[] = []) =>
  compactStatus("settled", { subject: "work", ...(outcome && { outcome }), issues });

describe("status precedence", () => {
  test("settled outcomes and issues combine by severity", () => {
    expect(status("cancelled", [issue()])).toBe("cancelled");
    expect(status("error", [warning])).toBe("error");
    expect(status("uncertain", [issue()])).toBe("error");
    expect(status("success", [issue()])).toBe("error");
    expect(status("uncertain", [warning])).toBe("uncertain");
    expect(status("success", [warning])).toBe("warning");
    expect(status("success", [info])).toBe("success");
    expect(status("warning", [info])).toBe("warning");
    expect(status("returned", [info])).toBe("returned");
    expect(status("returned", [warning])).toBe("warning");
    expect(status(undefined)).toBe("uncertain");
  });

  test("attention outranks routine outcomes but never becomes a warning or hides a problem", () => {
    expect(compactIssueSeverity([attention, info])).toBe("attention");
    expect(compactIssueSeverity([attention, warning])).toBe("warning");
    expect(status("success", [attention])).toBe("attention");
    expect(status("returned", [attention])).toBe("attention");
    expect(status("attention")).toBe("attention");
    expect(status("success", [attention, warning])).toBe("warning");
    expect(status("warning", [attention])).toBe("warning");
    expect(status("attention", [warning])).toBe("warning");
    expect(status("success", [attention, issue()])).toBe("error");
    expect(status("uncertain", [attention])).toBe("uncertain");
    expect(status("cancelled", [attention])).toBe("cancelled");
    const resolved = resolveCompactSummary(
      { subject: "work", outcome: "success", issues: [attention] },
      "settled",
      false,
    );
    expect(resolved?.outcome).toBe("success");
  });
});
