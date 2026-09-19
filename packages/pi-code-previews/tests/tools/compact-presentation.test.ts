import { expect, test } from "vitest";
import * as Schema from "effect/Schema";
import { createBoundedCompactIssuesSchema } from "../../src/tools/compact-issues-schema";
import { planCompactPresentation } from "../../src/tools/compact-presentation";
import type { CompactSummary } from "../../src/tools/compact-summary";
const plan = (summary: CompactSummary | undefined, isError = false) =>
  planCompactPresentation({ summary, isError, phase: "settled", expanded: true });

test("bounded retained issues reject every overflow and strip local renderer ownership", () => {
  const schema = createBoundedCompactIssuesSchema({
    maxTextLength: 12,
    maxEntries: 1,
    maxRecoveryEntries: 1,
    maxDiagnosticEntries: 1,
  });
  const issue = {
    operation: "call",
    code: "failure",
    severity: "error",
    cause: "cause",
    recovery: [{ code: "retry", text: "inspect" }],
    diagnostics: ["diagnostic"],
  };
  const decode = Schema.decodeUnknownSync(schema);
  const input = {
    coverage: "complete",
    entries: [{ ...issue, expandedInResult: true, fields: { cause: true } }],
  };
  expect(decode(input)).toEqual({ coverage: "complete", entries: [issue] });
  for (const entries of [
    [issue, issue],
    [{ ...issue, cause: "x".repeat(13) }],
    [{ ...issue, recovery: [...issue.recovery, ...issue.recovery] }],
    [{ ...issue, diagnostics: ["one", "two"] }],
  ]) {
    expect(() => decode({ coverage: "complete", entries })).toThrow(/length/iu);
  }
});

test("planner retains uncertainty, cancellation and explicit unknown coverage without inventing success", () => {
  expect(plan(undefined).collapsedSummary.outcome).toBe("uncertain");
  expect(plan(undefined).useExpandedContent).toBe(false);
  expect(plan({ subject: "unknown" }).summary).toBeUndefined();
  const cancelled = plan(
    { subject: "target", outcome: "cancelled", issues: { coverage: "unknown", entries: [] } },
    true,
  );
  expect(cancelled.summary?.outcome).toBe("cancelled");
  expect(cancelled.severity).toBe("warning");
  expect(cancelled.useExpandedContent).toBe(true);
  expect(cancelled.useFailure).toBe(false);
  const uncertain = plan(
    { subject: "target", outcome: "uncertain", issues: { coverage: "complete", entries: [] } },
    true,
  );
  expect(uncertain.summary?.outcome).toBe("uncertain");
  expect(uncertain.severity).toBe("error");
});
