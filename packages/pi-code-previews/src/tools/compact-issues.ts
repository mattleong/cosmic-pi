import * as Schema from "effect/Schema";
import { MESSAGE_TEXT_LIMIT } from "pi-cosmic-core";

/** Longest collapsed message. Longer producer text is clipped at render time. */
export const COMPACT_ISSUE_MESSAGE_LIMIT = MESSAGE_TEXT_LIMIT;

export const CompactIssueSchema = Schema.Struct({
  severity: Schema.Literals(["error", "warning", "info"]),
  /** Producer identity. Equal code, severity, and message merge. */
  code: Schema.String.check(Schema.isMinLength(1)),
  /** One short human line, identical collapsed and expanded. Never an agent procedure. */
  message: Schema.String,
  /** Agent-facing recovery or diagnostics. Shown only when expanded. */
  detail: Schema.optionalKey(Schema.String),
});
/** Presentation evidence only. Codes never grant execution or recovery authority. */
export type CompactIssue = typeof CompactIssueSchema.Type;
export type CompactIssueSeverity = CompactIssue["severity"];

/** Merge repeated evidence in first-seen order. Details keep every distinct line. */
export function mergeCompactIssues(
  ...lists: ReadonlyArray<readonly CompactIssue[] | undefined>
): CompactIssue[] {
  const merged: CompactIssue[] = [];
  for (const issue of lists.flatMap((list) => list ?? [])) {
    const index = merged.findIndex(
      (old) =>
        old.code === issue.code && old.severity === issue.severity && old.message === issue.message,
    );
    const old = merged[index];
    if (!old) {
      merged.push(issue);
      continue;
    }
    const lines = [
      ...new Set([...(old.detail?.split("\n") ?? []), ...(issue.detail?.split("\n") ?? [])]),
    ];
    merged[index] = { ...old, ...(lines.length > 0 && { detail: lines.join("\n") }) };
  }
  return merged;
}

/** Informational issues never change an outcome. */
export function compactIssueSeverity(
  issues: readonly CompactIssue[] | undefined,
): "error" | "warning" | undefined {
  if (issues?.some((issue) => issue.severity === "error")) return "error";
  return issues?.some((issue) => issue.severity === "warning") ? "warning" : undefined;
}
