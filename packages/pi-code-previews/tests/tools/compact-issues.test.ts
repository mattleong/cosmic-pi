import { describe, expect, test } from "vitest";
import * as Schema from "effect/Schema";
import {
  COMPACT_ISSUE_MESSAGE_LIMIT,
  compactIssueSeverity,
  mergeCompactIssues,
  type CompactIssue,
} from "../../src/tools/compact-issues";
import { issueMessageStyleProblems } from "../../src/testing/issue-messages";
import { createBoundedCompactIssuesSchema } from "../../src/tools/compact-issues-schema";
import {
  compactStatus,
  resolveCompactSummary,
  type CompactSummary,
} from "../../src/tools/compact-summary";

const issue = (overrides: Partial<CompactIssue> = {}): CompactIssue => ({
  severity: "error",
  code: "remote-failure",
  message: "Element detached",
  ...overrides,
});
const info = issue({ severity: "info", code: "hint", message: "Page 1 of 2" });
const warning = issue({ severity: "warning", code: "cleanup", message: "Cleanup is unconfirmed" });

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

  test("keeps evidence that differs in code, severity, or message", () => {
    const variants = [
      issue(),
      issue({ code: "other-producer" }),
      issue({ severity: "warning" }),
      issue({ message: "Session closed" }),
    ];
    expect(mergeCompactIssues(variants, variants)).toEqual(variants);
  });
});

test("severity ignores informational issues and prefers errors", () => {
  expect(compactIssueSeverity(undefined)).toBeUndefined();
  expect(compactIssueSeverity([info])).toBeUndefined();
  expect(compactIssueSeverity([info, warning])).toBe("warning");
  expect(compactIssueSeverity([warning, issue(), info])).toBe("error");
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

test("bounded retained issues accept valid evidence and reject every overflow", () => {
  const schema = createBoundedCompactIssuesSchema({ maxTextLength: 12, maxEntries: 1 });
  const accepts = Schema.is(schema);
  const valid = { severity: "warning", code: "cleanup", message: "Unconfirmed", detail: "Inspect" };
  expect(Schema.decodeUnknownSync(schema)([valid])).toEqual([valid]);
  expect(accepts([])).toBe(true);
  for (const rejected of [
    [valid, valid],
    [{ ...valid, code: "x".repeat(13) }],
    [{ ...valid, message: "x".repeat(13) }],
    [{ ...valid, detail: "x".repeat(13) }],
    [{ ...valid, severity: "fatal" }],
    [{ ...valid, code: "" }],
    [{ severity: "error", code: "missing-message" }],
  ])
    expect(accepts(rejected)).toBe(false);
  const wide = Schema.is(
    createBoundedCompactIssuesSchema({ maxTextLength: 10_000, maxEntries: 1 }),
  );
  // Collapsed messages stay one bounded line even when retained details may be longer.
  expect(wide([{ ...valid, message: "x".repeat(COMPACT_ISSUE_MESSAGE_LIMIT + 1) }])).toBe(false);
  expect(wide([{ ...valid, detail: "x".repeat(5_000) }])).toBe(true);
});

describe("summary resolution", () => {
  const base: CompactSummary = { subject: "work", outcome: "success" };

  test("rejects malformed summaries and settled summaries without an outcome", () => {
    expect(resolveCompactSummary(undefined, "settled", false)).toBeUndefined();
    expect(resolveCompactSummary({ subject: "work" }, "settled", false)).toBeUndefined();
    expect(resolveCompactSummary({ subject: "work" }, "running", false)).toEqual({
      subject: "work",
    });
    // Provider output crosses a runtime boundary; malformed values arrive untyped.
    const malformed: CompactSummary[] = JSON.parse(
      JSON.stringify([
        { subject: 42 },
        { subject: "work", outcome: "done" },
        {
          subject: "work",
          outcome: "success",
          issues: [{ severity: "fatal", code: "x", message: "" }],
        },
        {
          subject: "work",
          outcome: "success",
          issues: [{ severity: "error", code: "", message: "" }],
        },
        { subject: "work", outcome: "success", children: { total: -1, entries: [] } },
        {
          subject: "work",
          outcome: "success",
          children: { total: 1, entries: [{ label: "child", status: "done" }] },
        },
      ]),
    );
    for (const summary of malformed)
      expect(resolveCompactSummary(summary, "settled", false)).toBeUndefined();
  });

  test("passes summaries through unchanged without a Pi error", () => {
    const summary: CompactSummary = { ...base, issues: [warning] };
    expect(resolveCompactSummary(summary, "settled", false)).toBe(summary);
  });

  test("a Pi error overrides claimed success and explains itself with its first line", () => {
    for (const outcome of ["success", "returned", "warning", "error"] as const) {
      const resolved = resolveCompactSummary(
        { ...base, outcome, issues: [warning, info] },
        "settled",
        true,
        "\nRejected by host\nInternal stack",
      )!;
      expect(resolved.outcome).toBe("error");
      expect(resolved.issues?.[0]).toMatchObject({
        severity: "error",
        message: "Rejected by host",
      });
      expect(resolved.issues?.slice(1)).toEqual([warning, info]);
      expect(JSON.stringify(resolved)).not.toContain("Internal stack");
      expect(compactStatus("settled", resolved)).toBe("error");
    }
    const unexplained = resolveCompactSummary(base, "settled", true, "")!;
    expect(unexplained.issues).toHaveLength(1);
    expect(unexplained.issues?.[0]?.severity).toBe("error");
    expect(unexplained.issues?.[0]?.message.trim()).not.toBe("");
  });

  test("a child's error explains a Pi error only when the summary classifies an error", () => {
    const children = {
      total: 1,
      entries: [{ label: "bash", status: "error" as const, issues: [issue()] }],
    };
    const explained = resolveCompactSummary(
      { ...base, outcome: "error", children },
      "settled",
      true,
      "Host error text",
    )!;
    expect(explained.issues ?? []).toEqual([]);
    const claimedSuccess = resolveCompactSummary(
      { ...base, children },
      "settled",
      true,
      "Host error text",
    )!;
    expect(claimedSuccess.outcome).toBe("error");
    expect(claimedSuccess.issues?.[0]?.message).toBe("Host error text");
  });

  test("a producer's own error issue already explains a Pi error", () => {
    const resolved = resolveCompactSummary(
      { ...base, outcome: "warning", issues: [issue()] },
      "settled",
      true,
      "Host error text",
    )!;
    expect(resolved.outcome).toBe("error");
    expect(resolved.issues).toEqual([issue()]);
  });

  test("cancellation and uncertainty survive a Pi error flag", () => {
    for (const outcome of ["cancelled", "uncertain"] as const) {
      const summary: CompactSummary = { ...base, outcome };
      expect(resolveCompactSummary(summary, "settled", true, "Aborted")).toBe(summary);
    }
  });
});

const status = (outcome: CompactSummary["outcome"], issues: CompactIssue[] = []) =>
  compactStatus("settled", { subject: "work", ...(outcome && { outcome }), issues });

describe("status precedence", () => {
  test("live phases win over premature provider outcomes and issues", () => {
    for (const phase of ["pending", "running"] as const)
      for (const outcome of ["success", "error", "cancelled"] as const)
        expect(compactStatus(phase, { subject: "work", outcome, issues: [issue()] })).toBe(phase);
  });

  test("settled outcomes and issues combine by severity", () => {
    expect(status("cancelled", [issue()])).toBe("cancelled");
    expect(status("error", [warning])).toBe("error");
    expect(status("uncertain", [issue()])).toBe("error");
    expect(status("success", [issue()])).toBe("error");
    expect(status("uncertain", [warning])).toBe("uncertain");
    expect(status("success", [warning])).toBe("warning");
    expect(status("success", [info])).toBe("success");
    expect(status("warning", [info])).toBe("warning");
    // A neutral delivery stays neutral until an issue says otherwise.
    expect(status("returned", [info])).toBe("returned");
    expect(status("returned", [warning])).toBe("warning");
    expect(status(undefined)).toBe("uncertain");
  });

  test("children never change their parent's status", () => {
    const summary: CompactSummary = {
      subject: "program",
      outcome: "warning",
      children: {
        total: 2,
        entries: [
          { label: "read", status: "error", issues: [issue()] },
          { label: "mcp", status: "cancelled" },
        ],
      },
    };
    expect(compactStatus("settled", summary)).toBe("warning");
    expect(compactStatus("settled", { ...summary, outcome: "success" })).toBe("success");
  });
});
