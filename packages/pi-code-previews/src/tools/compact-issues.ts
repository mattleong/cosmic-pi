import * as Schema from "effect/Schema";
import type { CompactNotice, CompactSummary } from "./compact-summary";

/** Presentation evidence only. Identities never grant execution or recovery authority. */
export interface CompactIssue {
  readonly operation: string;
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly cause: string;
  /** Human-facing compact explanation. Empty means agent-only detail. Never ownership evidence. */
  readonly description?: string | undefined;
  readonly recovery: readonly { readonly code: string; readonly text: string }[];
  readonly diagnostics?: readonly string[];
}
export interface CompactIssues {
  readonly coverage: "complete" | "unknown";
  readonly entries: readonly CompactIssue[];
}

const Identity = Schema.String.check(Schema.isMinLength(1));
const IssueEvidenceSchema = Schema.Struct({
  operation: Identity,
  code: Identity,
  severity: Schema.Literals(["error", "warning"]),
  cause: Schema.String,
  recovery: Schema.Array(Schema.Struct({ code: Identity, text: Schema.String })),
  diagnostics: Schema.optionalKey(Schema.Array(Schema.String)),
});
const IssueSchema = Schema.Struct({
  ...IssueEvidenceSchema.fields,
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(240))),
});
export const CompactIssuesSchema = Schema.Struct({
  coverage: Schema.Literals(["complete", "unknown"]),
  entries: Schema.Array(IssueSchema),
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
        (old) => old.severity === issue.severity && old.cause === issue.cause,
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
        entries[index] = {
          ...same,
          // Conflicting wording cannot conceal distinct or more cautious evidence.
          description: same.description === issue.description ? same.description : undefined,
          recovery: [...same.recovery, ...recovery],
          ...((same.diagnostics || issue.diagnostics) && {
            diagnostics: [...new Set([...(same.diagnostics ?? []), ...(issue.diagnostics ?? [])])],
          }),
        };
      } else entries.push({ ...issue, recovery: [...recovery] });
    }
  }
  return { coverage: complete ? "complete" : "unknown", entries };
}

/** A detached evidence snapshot, not an identity-based promise about future merges. */
export interface CompactIssueClaim extends Omit<CompactIssue, "description"> {
  readonly fields: {
    readonly cause?: true;
    readonly recovery?: readonly string[];
    readonly diagnostics?: readonly number[];
  };
}

export const CompactIssueClaimSchema = Schema.Struct({
  ...IssueEvidenceSchema.fields,
  fields: Schema.Struct({
    cause: Schema.optionalKey(Schema.Literal(true)),
    recovery: Schema.optionalKey(Schema.Array(Identity)),
    diagnostics: Schema.optionalKey(Schema.Array(Schema.Natural)),
  }),
});
const isClaim = Schema.is(CompactIssueClaimSchema);

export function claimCompactIssue(
  issue: CompactIssue,
  fields: CompactIssueClaim["fields"],
): CompactIssueClaim {
  return {
    operation: issue.operation,
    code: issue.code,
    severity: issue.severity,
    cause: issue.cause,
    recovery: issue.recovery.map((entry) => ({ ...entry })),
    ...(issue.diagnostics && { diagnostics: [...issue.diagnostics] }),
    fields: {
      ...(fields.cause && { cause: true }),
      ...(fields.recovery && { recovery: [...fields.recovery] }),
      ...(fields.diagnostics && { diagnostics: [...fields.diagnostics] }),
    },
  };
}

/** Validate against the entire aggregate before subtracting any selected field.
 * Conflicting causes/severity or operation-scoped recovery codes revoke ownership.
 */
export function subtractCompactIssueClaims(
  issues: CompactIssues,
  claims: readonly CompactIssueClaim[] | undefined = undefined,
): CompactIssues {
  const valid = (claims ?? []).filter((claim) => {
    if (!isClaim(claim)) return false;
    const same = issues.entries.filter(
      (entry) => entry.operation === claim.operation && entry.code === claim.code,
    );
    if (
      !same.length ||
      same.some((entry) => entry.cause !== claim.cause || entry.severity !== claim.severity)
    )
      return false;
    const evidence = issues.entries
      .filter((entry) => entry.operation === claim.operation)
      .flatMap((entry) => entry.recovery);
    const snapshot = new Map<string, string>();
    for (const entry of claim.recovery) {
      if (snapshot.has(entry.code) && snapshot.get(entry.code) !== entry.text) return false;
      snapshot.set(entry.code, entry.text);
      if (!evidence.some((current) => current.code === entry.code && current.text === entry.text))
        return false;
    }
    if (
      evidence.some((entry) =>
        evidence.some((other) => other.code === entry.code && other.text !== entry.text),
      )
    )
      return false;
    if (claim.fields.recovery?.some((code) => !snapshot.has(code))) return false;
    if (
      claim.fields.diagnostics?.some(
        (index) =>
          !Number.isInteger(index) || index < 0 || claim.diagnostics?.[index] === undefined,
      )
    )
      return false;
    const diagnostics = same.flatMap((entry) => entry.diagnostics ?? []);
    return (
      (claim.diagnostics ?? []).every((text) => diagnostics.includes(text)) &&
      (claim.fields.diagnostics ?? []).every((index) => {
        const text = claim.diagnostics?.[index];
        return (
          claim.diagnostics?.filter((entry) => entry === text).length === 1 &&
          diagnostics.filter((entry) => entry === text).length === 1
        );
      })
    );
  });
  return {
    ...issues,
    entries: issues.entries.flatMap((issue) => {
      const own = valid.filter(
        (claim) => claim.operation === issue.operation && claim.code === issue.code,
      );
      const cause = own.some((claim) => claim.fields.cause) ? "" : issue.cause;
      const recovery = issue.recovery.filter(
        (entry) =>
          !valid.some(
            (claim) =>
              claim.operation === issue.operation &&
              claim.fields.recovery?.includes(entry.code) &&
              claim.recovery.some(
                (snapshot) => snapshot.code === entry.code && snapshot.text === entry.text,
              ),
          ),
      );
      const diagnostics = issue.diagnostics?.filter(
        (text) =>
          !own.some((claim) =>
            claim.fields.diagnostics?.some((index) => claim.diagnostics?.[index] === text),
          ),
      );
      return cause || recovery.length || diagnostics?.length
        ? [{ ...issue, cause, recovery, ...(diagnostics && { diagnostics }) }]
        : [];
    }),
  };
}

export const withoutFailureBodyIssues = subtractCompactIssueClaims;

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
              code: notice.code ?? `legacy-${index}`,
              severity: notice.kind === "error" ? ("error" as const) : ("warning" as const),
              cause: notice.text,
              description: notice.description ?? (notice.kind === "recovery" ? "" : undefined),
              recovery: [],
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
      description: summary.failure.description,
      recovery: [],
    });
  for (const [index, notice] of (summary.notices ?? []).entries()) {
    if (notice.code && notice.kind === "recovery" && notice.expandedOnly) continue;
    entries.push({
      operation,
      code: notice.code ?? `notice-${index}`,
      severity: notice.kind === "error" ? "error" : "warning",
      cause: notice.kind === "recovery" ? "" : notice.text,
      description: notice.description ?? (notice.kind === "recovery" ? "" : undefined),
      recovery:
        notice.kind === "recovery"
          ? [{ code: notice.code ?? `notice-${index}`, text: notice.text }]
          : [],
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
