import { expect, test } from "vitest";
import {
  claimCompactIssue,
  normalizeCompactIssues,
  subtractCompactIssueClaims,
  type CompactIssue,
} from "../../src/tools/compact-issues";
import { renderCompactIssues } from "../../src/preview/compact-issues";
import { testTheme } from "../support/render";

const issue: CompactIssue = {
  operation: "private-id",
  code: "unknown",
  severity: "warning",
  cause: "Canonical cause",
  description: "Human explanation",
  recovery: [{ code: "inspect", text: "Agent-only procedure" }],
  diagnostics: ["Full diagnostic"],
};
const collection = (...entries: CompactIssue[]) => ({ coverage: "complete" as const, entries });

test("wording neither merges independent evidence nor grants expanded ownership", () => {
  const other = { ...issue, operation: "other-private-id" };
  const combined = normalizeCompactIssues([collection(issue, other)]);
  expect(combined.entries).toHaveLength(2);
  const text = renderCompactIssues(combined, testTheme(), 100).join("\n");
  expect(text.split(issue.description!)).toHaveLength(3);
  expect(text).not.toContain(issue.operation);
  expect(text).not.toContain(issue.recovery[0]!.text);
  const claim = claimCompactIssue(issue, { cause: true });
  const rewritten = { ...issue, description: "Changed display wording" };
  const remaining = subtractCompactIssueClaims(collection(rewritten, other), [claim]);
  expect(remaining.entries[0]?.cause).toBe("");
  expect(remaining.entries[0]?.recovery).toEqual(issue.recovery);
  expect(remaining.entries[1]?.cause).toBe(issue.cause);
  const unrelatedDisplayField = { ...claim, description: "x".repeat(1_000) };
  expect(subtractCompactIssueClaims(collection(rewritten, other), [unrelatedDisplayField])).toEqual(
    remaining,
  );
  const changedEvidence = { ...rewritten, cause: "Different evidence" };
  expect(subtractCompactIssueClaims(collection(changedEvidence), [claim])).toEqual(
    collection(changedEvidence),
  );
});

test("conflicting wording falls back without changing evidence or hiding expansion", () => {
  const conflicting = { ...issue, description: "Conflicting display wording" };
  const combined = normalizeCompactIssues([collection(issue), collection(conflicting)]);
  expect(combined.entries[0]?.description).toBeUndefined();
  expect(combined.entries[0]?.cause).toBe(issue.cause);
  const collapsed = renderCompactIssues(combined, testTheme(), 100).join("\n");
  expect(collapsed).not.toContain(issue.cause);
  expect(collapsed).not.toContain(issue.recovery[0]!.text);
  expect(collapsed.length).toBeGreaterThan(0);
  const expanded = renderCompactIssues(combined, testTheme(), 100, true).join("\n");
  for (const text of [issue.cause, issue.recovery[0]!.text, issue.diagnostics![0]!])
    expect(expanded).toContain(text);
});

test("agent-only entries are hidden only in compact display", () => {
  const agentOnly = { ...issue, description: "" };
  expect(renderCompactIssues(collection(agentOnly), testTheme(), 100)).toEqual([]);
  const expanded = renderCompactIssues(collection(agentOnly), testTheme(), 100, true).join("\n");
  expect(expanded).toContain(agentOnly.cause);
  expect(expanded).toContain(agentOnly.recovery[0]!.text);
});
