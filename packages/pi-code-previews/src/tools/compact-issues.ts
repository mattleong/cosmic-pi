import * as Schema from "effect/Schema";
import type { CompactNotice, CompactSummary } from "./compact-summary";

/** Presentation evidence only. Identities never grant execution or recovery authority. */
export interface CompactIssue {
  readonly operation: string;
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly cause: string;
  readonly recovery: readonly { readonly code: string; readonly text: string }[];
  readonly diagnostics?: readonly string[];
  readonly expandedInResult?: true;
}
export interface CompactIssues {
  readonly coverage: "complete" | "unknown";
  readonly entries: readonly CompactIssue[];
}

const Identity = Schema.String.check(Schema.isMinLength(1));
export const CompactIssuesSchema = Schema.Struct({
  coverage: Schema.Literals(["complete", "unknown"]),
  entries: Schema.Array(
    Schema.Struct({
      operation: Identity,
      code: Identity,
      severity: Schema.Literals(["error", "warning"]),
      cause: Schema.String,
      recovery: Schema.Array(Schema.Struct({ code: Identity, text: Schema.String })),
      diagnostics: Schema.optionalKey(Schema.Array(Schema.String)),
      expandedInResult: Schema.optionalKey(Schema.Literal(true)),
    }),
  ),
});
export const isCompactIssues = Schema.is(CompactIssuesSchema);

/** Equal identities coalesce only when their evidence agrees. Conflicts remain visible.
 * Recovery identities are scoped to the operation, independent of the causing issue.
 */
export function normalizeCompactIssues(collections: readonly CompactIssues[]): CompactIssues {
  const entries: CompactIssue[] = [];
  const recoveries: Array<{ operation: string; code: string; text: string }> = [];
  let complete = collections.every((collection) => collection.coverage === "complete");
  for (const collection of collections) {
    for (const issue of collection.entries) {
      const sameIdentity = entries.filter(
        (old) => old.operation === issue.operation && old.code === issue.code,
      );
      const same = sameIdentity.find(
        (old) =>
          old.severity === issue.severity &&
          old.cause === issue.cause &&
          old.expandedInResult === issue.expandedInResult &&
          JSON.stringify(old.diagnostics) === JSON.stringify(issue.diagnostics),
      );
      if (sameIdentity.length && !same) complete = false;
      const recovery = issue.recovery.filter((instruction) => {
        const matches = recoveries.filter(
          (old) => old.operation === issue.operation && old.code === instruction.code,
        );
        if (matches.some((old) => old.text === instruction.text)) return false;
        if (matches.length) complete = false;
        recoveries.push({ operation: issue.operation, ...instruction });
        return true;
      });
      if (same) {
        const index = entries.indexOf(same);
        entries[index] = { ...same, recovery: [...same.recovery, ...recovery] };
      } else entries.push({ ...issue, recovery: [...recovery] });
    }
  }
  return { coverage: complete ? "complete" : "unknown", entries };
}

export function compactIssueSeverity(issues: CompactIssues): "error" | "warning" | undefined {
  return issues.entries.some((issue) => issue.severity === "error")
    ? "error"
    : issues.entries.length
      ? "warning"
      : undefined;
}

/** Compatibility retains every unidentified instruction, without guessing equivalence. */
export function legacyCompactIssues(
  notices: readonly CompactNotice[] | undefined,
  operation: string,
  expanded = false,
): CompactIssues {
  return {
    coverage: "unknown",
    entries: (notices ?? []).flatMap((notice, index) =>
      !expanded && notice.code && notice.kind === "recovery" && notice.expandedOnly
        ? []
        : [
            {
              operation,
              code: `legacy-${index}`,
              severity: notice.kind === "error" ? ("error" as const) : ("warning" as const),
              cause: notice.text,
              recovery: [],
              ...(notice.expandedInResult && { expandedInResult: true as const }),
            },
          ],
    ),
  };
}

/** Compatibility helper for classified producers. Uncoded text keeps unknown coverage;
 * local index identities never prove parent/child equivalence. Only explicitly classified
 * informational recovery may stay expanded-only.
 */
export function withCompactIssues<T extends CompactSummary>(
  summary: T,
  operation: string,
): T & { issues: CompactIssues } {
  const entries: CompactIssue[] = [];
  if (summary.failure && summary.outcome !== "cancelled")
    entries.push({
      operation,
      code: summary.failureEvidence?.code ?? "failure",
      severity: summary.outcome === "uncertain" ? "warning" : "error",
      cause: summary.failure.cause,
      recovery: [],
      expandedInResult: true,
    });
  for (const [index, notice] of (summary.notices ?? []).entries()) {
    if (notice.code && notice.kind === "recovery" && notice.expandedOnly) continue;
    entries.push({
      operation,
      code: notice.code ?? `notice-${index}`,
      severity: notice.kind === "error" ? "error" : "warning",
      cause: notice.kind === "recovery" ? "" : notice.text,
      recovery:
        notice.kind === "recovery"
          ? [{ code: notice.code ?? `notice-${index}`, text: notice.text }]
          : [],
      ...(notice.expandedInResult && { expandedInResult: true }),
    });
  }
  return {
    ...summary,
    issues: normalizeCompactIssues([
      {
        coverage:
          (summary.failure && summary.failureEvidence?.coverage !== "complete") ||
          summary.notices?.some((notice) => !notice.code)
            ? "unknown"
            : "complete",
        entries,
      },
    ]),
  };
}

/** Aggregate all retained children before choosing rows. Missing receipts stay conservative. */
export function summaryCompactIssues(summary: CompactSummary, expanded = false): CompactIssues {
  const own = summary.issues ?? legacyCompactIssues(summary.notices, "outer", expanded);
  const informational =
    expanded && summary.issues
      ? legacyCompactIssues(
          summary.notices?.filter((notice) => notice.kind === "recovery" && notice.expandedOnly),
          "outer-information",
          true,
        )
      : undefined;
  return normalizeCompactIssues([
    own,
    ...(informational ? [informational] : []),
    ...(summary.children?.entries.flatMap((child, index) => [
      child.issues ?? legacyCompactIssues(child.notices, `child-${index + 1}`, expanded),
      ...(expanded && child.issues
        ? [
            legacyCompactIssues(
              child.notices?.filter((notice) => notice.kind === "recovery" && notice.expandedOnly),
              `child-${index + 1}-information`,
              true,
            ),
          ]
        : []),
    ]) ?? []),
  ]);
}
