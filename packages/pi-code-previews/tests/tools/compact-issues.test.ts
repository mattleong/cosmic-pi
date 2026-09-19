import { describe, expect, test } from "vitest";
import {
  compactIssueSeverity,
  claimCompactIssue,
  subtractCompactIssueClaims,
  normalizeCompactIssues,
  summaryCompactIssues,
  withCompactIssues,
  withoutFailureBodyIssues,
  type CompactIssue,
  type CompactIssues,
} from "../../src/tools/compact-issues";
import {
  compactStatus,
  resolveCompactSummary,
  type CompactSummary,
} from "../../src/tools/compact-summary";
import { renderCompactToolCall } from "../../src/preview/compact-tool-call";
import { renderCompactFailure } from "../../src/preview/compact-tool-call";
import { testTheme } from "../support/render";

const issue = (overrides: Partial<CompactIssue> = {}): CompactIssue => ({
  operation: "call-1",
  code: "remote-failure",
  severity: "error",
  cause: "Element detached.",
  description: overrides.cause ?? "Element detached.",
  recovery: [{ code: "inspect", text: "Inspect state before retrying." }],
  ...overrides,
});
const collection = (...entries: CompactIssue[]): CompactIssues => ({
  coverage: "complete",
  entries,
});

test("legacy projection cannot classify or hide unknown recovery", () => {
  const summary = withCompactIssues(
    {
      subject: "legacy",
      notices: [
        { kind: "recovery", text: "Confirm cleanup before proceeding.", expandedOnly: true },
      ],
    },
    "operation",
  );
  expect(summary.issues.coverage).toBe("unknown");
  expect(
    summary.issues.entries.flatMap((entry) => entry.recovery).map((entry) => entry.text),
  ).toEqual(["Confirm cleanup before proceeding."]);
});

describe("semantic compact issues", () => {
  test("matching identities coalesce, independent invocations and conflicts survive", () => {
    const original = issue();
    const differentCall = issue({ operation: "call-2" });
    const conflict = issue({ cause: "Session closed." });
    const sources = [collection(original), collection(original, differentCall, conflict)];
    const before = JSON.stringify(sources);
    const normalized = normalizeCompactIssues(sources);
    expect(normalized.entries.map(({ operation, cause }) => ({ operation, cause }))).toEqual([
      { operation: "call-1", cause: "Element detached." },
      { operation: "call-2", cause: "Element detached." },
      { operation: "call-1", cause: "Session closed." },
    ]);
    expect(normalized.coverage).toBe("unknown");
    expect(JSON.stringify(sources)).toBe(before);
  });

  test("recovery has its own identities, order, and conflict handling", () => {
    const normalized = normalizeCompactIssues([
      collection(issue()),
      collection(
        issue({
          recovery: [
            { code: "inspect", text: "Inspect state before retrying." },
            { code: "inspect", text: "Inspect the destination instead." },
            { code: "retain", text: "Keep the original output." },
          ],
        }),
      ),
    ]);
    expect(normalized.entries).toHaveLength(1);
    expect(normalized.entries[0]?.recovery.map(({ text }) => text)).toEqual([
      "Inspect state before retrying.",
      "Inspect the destination instead.",
      "Keep the original output.",
    ]);
    expect(normalized.coverage).toBe("unknown");
  });

  test("error precedence preserves uncertainty, cleanup and their recovery", () => {
    const issues = normalizeCompactIssues([
      collection(
        issue(),
        issue({
          code: "uncertain",
          severity: "warning",
          cause: "Execution is uncertain.",
          recovery: [{ code: "no-replay", text: "Do not replay." }],
        }),
        issue({
          code: "cleanup",
          severity: "warning",
          cause: "Cleanup is unconfirmed.",
          recovery: [],
        }),
      ),
    ]);
    expect(compactIssueSeverity(issues)).toBe("error");
    const summary: CompactSummary = { subject: "operation", outcome: "uncertain", issues };
    expect(compactStatus("settled", summary)).toBe("error");
    expect(summary.outcome).toBe("uncertain");
    const output = renderCompactToolCall(
      { name: "mcp", phase: "settled", summary },
      testTheme(),
      120,
    ).join("\n");
    for (const text of ["Element detached.", "Execution is uncertain.", "Cleanup is unconfirmed."])
      expect(output).toContain(text);
  });

  test("all retained children contribute before display selection", () => {
    const summary: CompactSummary = {
      subject: "batch",
      outcome: "error",
      issues: collection(),
      children: {
        total: 8,
        entries: Array.from({ length: 8 }, (_, index) => ({
          label: `child-${index}`,
          status: "error",
          issues: collection(issue({ operation: `call-${index}` })),
        })),
      },
    };
    expect(summaryCompactIssues(summary).entries).toHaveLength(8);
    const text = renderCompactToolCall(
      { name: "code_mode", phase: "settled", summary },
      testTheme(),
      120,
    ).join("\n");
    for (let index = 0; index < 8; index++) expect(text).not.toContain(`call-${index}:`);
    expect(text.match(/Element detached\./gu)).toHaveLength(8);
  });

  test("matching identified parent propagation is shown once", () => {
    const evidence = collection(issue());
    const summary: CompactSummary = {
      subject: "batch",
      outcome: "error",
      issues: evidence,
      children: { total: 1, entries: [{ label: "mcp", status: "error", issues: evidence }] },
    };
    expect(summaryCompactIssues(summary).entries).toHaveLength(1);
    const text = renderCompactToolCall(
      { name: "code_mode", phase: "settled", summary },
      testTheme(),
      120,
    ).join("\n");
    expect(text.match(/Element detached\./gu)).toHaveLength(1);
  });

  test("legacy notices never coalesce across invocations or matching prose", () => {
    const notice = { kind: "warning" as const, text: "Inspect state." };
    const summary: CompactSummary = {
      subject: "batch",
      outcome: "warning",
      notices: [notice],
      children: {
        total: 2,
        entries: [0, 1].map(() => ({ label: "mcp", status: "warning", notices: [notice] })),
      },
    };
    expect(summaryCompactIssues(summary).entries).toHaveLength(3);
    expect(summaryCompactIssues(summary).coverage).toBe("unknown");
  });

  test("cancellation is not an issue without independent evidence", () => {
    const summary = withCompactIssues(
      {
        subject: "operation",
        outcome: "cancelled" as const,
        failure: { cause: "Cancelled", details: "Operation aborted" },
        failureEvidence: { code: "cancelled", cause: "Cancelled", coverage: "complete" as const },
      },
      "call-1",
    );
    expect(summary.issues.entries).toEqual([]);
    expect(compactStatus("settled", summary)).toBe("cancelled");
    expect(resolveCompactSummary(summary, "settled", true)?.outcome).toBe("cancelled");
    const warning = withCompactIssues(
      { ...summary, notices: [{ kind: "warning" as const, text: "Cleanup unconfirmed." }] },
      "call-1",
    );
    expect(compactIssueSeverity(warning.issues)).toBe("warning");
  });

  test("explicit expanded ownership, not body substring matching, removes duplicate recovery", () => {
    const summary = withCompactIssues(
      {
        subject: "operation",
        outcome: "error" as const,
        failure: {
          cause: "Refused.",
          description: "Refused.",
          details: "Full diagnostics.\nInspect state.",
        },
        failureEvidence: { code: "refused", cause: "Refused.", coverage: "complete" as const },
        notices: [
          {
            code: "inspect",
            kind: "recovery" as const,
            text: "Inspect state.",
          },
        ],
      },
      "call-1",
    );
    Object.assign(summary.failure, {
      ownedIssues: summary.issues.entries.map((entry) =>
        claimCompactIssue(entry, { cause: true, recovery: entry.recovery.map(({ code }) => code) }),
      ),
    });
    for (const expanded of [false, true]) {
      const text = renderCompactFailure(
        { name: "edit", phase: "settled", summary, failure: summary.failure, expanded },
        testTheme(),
        120,
      ).join("\n");
      expect(text.match(/Inspect state\./gu) ?? []).toHaveLength(expanded ? 1 : 0);
      expect(text).toContain(expanded ? "Full diagnostics." : "Refused.");
    }
  });
});

test("outer failure ownership cannot consume nested evidence, even with identical wording", () => {
  const root = issue({
    operation: "outer",
    code: "copied",
    cause: "Same diagnostic",
    recovery: [],
  });
  const nested = issue({ operation: "child-1", cause: "Same diagnostic" });
  const summary: CompactSummary = {
    subject: "execute",
    outcome: "error",
    issues: collection(root, nested),
    failure: {
      cause: root.cause,
      details: root.cause,
      ownedIssues: [claimCompactIssue(root, { cause: true })],
    },
  };
  const text = renderCompactFailure(
    { name: "code_mode", phase: "settled", summary, failure: summary.failure!, expanded: true },
    testTheme(),
    200,
  ).join("\n");
  expect(text.split(root.cause).length - 1).toBe(2);
  expect(text).toContain(nested.recovery[0]!.text);
  const augmented = normalizeCompactIssues([
    collection(root),
    collection({ ...root, recovery: [{ code: "new-repair", text: "Independent repair" }] }),
  ]);
  const retained = withoutFailureBodyIssues(augmented, summary.failure!.ownedIssues);
  expect(retained.entries).toEqual([
    { ...root, cause: "", recovery: [{ code: "new-repair", text: "Independent repair" }] },
  ]);
  const diagnostic = { ...root, diagnostics: ["Independent diagnostic"] };
  expect(
    withoutFailureBodyIssues(collection(diagnostic), summary.failure!.ownedIssues).entries,
  ).toEqual([{ ...diagnostic, cause: "" }]);
  const conflict = { ...root, cause: "Conflicting recovery" };
  expect(
    withoutFailureBodyIssues(collection(root, conflict), summary.failure!.ownedIssues).entries,
  ).toEqual([root, conflict]);
  const conflictingRecovery = {
    ...root,
    recovery: [
      { code: "repair", text: "First repair" },
      { code: "repair", text: "Conflicting repair" },
    ],
  };
  expect(
    withoutFailureBodyIssues(collection(conflictingRecovery), summary.failure!.ownedIssues).entries,
  ).toEqual([conflictingRecovery]);
});

test("claims select detached fields without absorbing merged or conflicting evidence", () => {
  const original = issue({ diagnostics: ["first diagnostic"] });
  const claim = claimCompactIssue(original, {
    cause: true,
    recovery: ["inspect"],
    diagnostics: [0],
  });
  const added = issue({
    recovery: [{ code: "other", text: "New recovery" }],
    diagnostics: ["second diagnostic"],
  });
  const merged = normalizeCompactIssues([collection(original), collection(added)]);
  expect(subtractCompactIssueClaims(merged, [claim]).entries).toEqual([
    { ...merged.entries[0], cause: "", recovery: added.recovery, diagnostics: added.diagnostics },
  ]);
  const secondClaim = claimCompactIssue(added, { diagnostics: [0] });
  expect(subtractCompactIssueClaims(merged, [secondClaim]).entries[0]?.diagnostics).toEqual([
    "first diagnostic",
  ]);
  const sibling = issue({ code: "sibling" });
  const across = normalizeCompactIssues([collection(original, sibling)]);
  expect(
    subtractCompactIssueClaims(across, [
      claimCompactIssue(sibling, { recovery: ["inspect"] }),
    ]).entries.flatMap((entry) => entry.recovery),
  ).toEqual([]);
  for (const conflicting of [
    issue({ cause: "changed cause" }),
    issue({ recovery: [{ code: "inspect", text: "changed instruction" }] }),
  ]) {
    const aggregate = normalizeCompactIssues([collection(original, conflicting)]);
    expect(subtractCompactIssueClaims(aggregate, [claim])).toEqual(aggregate);
  }
  const stale = collection(issue({ diagnostics: ["changed diagnostic"] }));
  expect(subtractCompactIssueClaims(stale, [claim])).toEqual(stale);
});

test("Pi failure cannot be hidden by a success summary with an owned failure body", () => {
  const resolved = resolveCompactSummary(
    {
      subject: "operation",
      outcome: "success",
      failure: { cause: "Rejected by Pi", details: "Rejected by Pi" },
      issues: collection(),
    },
    "settled",
    true,
  )!;
  expect(compactStatus("settled", resolved)).toBe("error");
  expect(resolved.issues?.entries.some((entry) => entry.cause === "Rejected by Pi")).toBe(true);
});

test("Pi failure adds severity without erasing structured execution uncertainty", () => {
  const resolved = resolveCompactSummary(
    { subject: "operation", outcome: "uncertain", issues: collection() },
    "settled",
    true,
  )!;
  expect(resolved.outcome).toBe("uncertain");
  expect(compactStatus("settled", resolved)).toBe("error");
  expect(resolved.issues?.entries.some((entry) => entry.code === "execution-uncertain")).toBe(true);
});
