import * as Schema from "effect/Schema";
import { MESSAGE_TEXT_LIMIT } from "pi-cosmic-core";

export const COMPACT_ISSUE_MESSAGE_LIMIT = MESSAGE_TEXT_LIMIT;

export const CompactIssueSchema = Schema.Struct({
  severity: Schema.Literals(["error", "warning", "info"]),
  code: Schema.String.check(Schema.isMinLength(1)),
  message: Schema.String,
  detail: Schema.optionalKey(Schema.String),
});
export type CompactIssue = typeof CompactIssueSchema.Type;

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

export function compactIssueSeverity(
  issues: readonly CompactIssue[] | undefined,
): "error" | "warning" | undefined {
  if (issues?.some((issue) => issue.severity === "error")) return "error";
  return issues?.some((issue) => issue.severity === "warning") ? "warning" : undefined;
}
