import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import { MESSAGE_TEXT_LIMIT } from "pi-cosmic-core/message-text";

export const COMPACT_ISSUE_MESSAGE_LIMIT = MESSAGE_TEXT_LIMIT;

export const CompactIssueSchema = Schema.Struct({
  // `attention`: someone is waiting on a reply or decision. It shows like a warning but is no problem.
  severity: Schema.Literals(["error", "warning", "attention", "info"]),
  code: Schema.String.check(Schema.isMinLength(1)),
  message: Schema.String,
  detail: Schema.optionalKey(Schema.String),
});
export type CompactIssue = typeof CompactIssueSchema.Type;

export function mergeCompactIssues(
  ...lists: ReadonlyArray<readonly CompactIssue[] | undefined>
): CompactIssue[] {
  const merged: CompactIssue[] = [];
  for (const issue of Arr.flatMap(lists, (list) => list ?? [])) {
    const found = Arr.findFirstWithIndex(
      merged,
      (old) =>
        old.code === issue.code && old.severity === issue.severity && old.message === issue.message,
    );
    if (Option.isNone(found)) {
      merged.push(issue);
      continue;
    }
    const [old, index] = found.value;
    const lines = [
      ...new Set([
        ...(old.detail === undefined ? [] : Str.split(old.detail, "\n")),
        ...(issue.detail === undefined ? [] : Str.split(issue.detail, "\n")),
      ]),
    ];
    merged[index] = { ...old, ...(lines.length > 0 && { detail: Arr.join(lines, "\n") }) };
  }
  return merged;
}

/** The issue severities shown collapsed, strongest first. */
export const COMPACT_SIGNAL_SEVERITIES = ["error", "warning", "attention"] as const;
export type CompactSignalSeverity = (typeof COMPACT_SIGNAL_SEVERITIES)[number];

/** The strongest collapsed severity among `issues`; information never signals. */
export function compactIssueSeverity(
  issues: readonly CompactIssue[] | undefined,
): CompactSignalSeverity | undefined {
  return Option.getOrUndefined(
    Arr.findFirst(COMPACT_SIGNAL_SEVERITIES, (severity) =>
      Arr.some(issues ?? [], (issue) => issue.severity === severity),
    ),
  );
}
